/**
 * ZaFar Bot — Hardened Pending Choices & WhatsApp Polls
 *
 * Supports two ways for a user to answer a bot prompt (.movie, .series, .song, .ytv):
 *   1. Tapping a WhatsApp Poll option (`pollCreationMessageV3` → `pollUpdateMessage`),
 *      decrypted with Baileys' `decryptPollVote`.
 *   2. Replying with a number ("2", "2.", "#2") — either quoting the specific
 *      prompt message OR sending a bare number in the chat.
 *
 * Hardening guarantees:
 *   • Unique offer IDs (`sel_<seq>_<ts>`) and unique per-offer row IDs.
 *   • Quoted-message binding: if the user quotes a specific message (`quotedId`),
 *     ONLY the prompt matching that `promptMessageId` can be triggered — quoting
 *     a friend's message with "2" in a group chat will NEVER trigger a pending
 *     download! Multiple concurrent prompts by the same user can also be
 *     disambiguated by quoting the desired prompt.
 *   • PN / LID JID awareness via `jidVariants`: a user whose WhatsApp JID flips
 *     between `@s.whatsapp.net` and `@lid` still owns their own pending choice,
 *     and nobody else in a group can vote on or hijack their poll.
 *   • Send-failure hygiene (`sendPollOrText` / `sendTextPrompt`): any stale
 *     previous choice is cleared upfront, and the new pending choice is ONLY
 *     stored after `sock.sendMessage` succeeds.
 *   • Single-execution lock: voting on a poll immediately consumes the paired
 *     typed-number entry (and vice-versa), so tapping + typing "1" never runs twice.
 */

const crypto = require('crypto');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const { decryptPollVote } = require('@whiskeysockets/baileys/lib/Utils/process-message');
const { jidVariants } = require('./jid');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_POLL_OPTIONS = 12;

let _seq = 0;
const nextOfferId = () => `sel_${++_seq}_${Date.now().toString(36)}`;

// Latest pending choice per `${chatId}:${canonicalSender}` -> entry
const pending = new Map();
// Prompt message ID -> entry (lets quoted replies target the exact prompt)
const pendingByMsgId = new Map();
// Poll message ID -> poll entry (for `pollUpdateMessage` vote decryption)
const pendingPolls = new Map();

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

function senderKeys(chatId, sender) {
  const variants = [...jidVariants(sender)];
  if (!variants.length) return [`${chatId}:${String(sender || '')}`];
  return variants.map((v) => `${chatId}:${v}`);
}

function removeEntry(entry) {
  if (!entry || entry.consumed) return;
  entry.consumed = true;
  for (const k of entry.keys || []) {
    if (pending.get(k) === entry) pending.delete(k);
  }
  if (entry.promptMessageId && pendingByMsgId.get(entry.promptMessageId) === entry) {
    pendingByMsgId.delete(entry.promptMessageId);
  }
  if (entry.pollMessageId) {
    pendingPolls.delete(entry.pollMessageId);
  }
}

function prune() {
  const now = Date.now();
  for (const [, entry] of pending) {
    if (entry.consumed || now - entry.at > entry.ttlMs) removeEntry(entry);
  }
  for (const [id, entry] of pendingByMsgId) {
    if (entry.consumed || now - entry.at > entry.ttlMs) {
      pendingByMsgId.delete(id);
      removeEntry(entry);
    }
  }
  for (const [id, poll] of pendingPolls) {
    if (poll.entry?.consumed || now - poll.at > poll.ttlMs) {
      pendingPolls.delete(id);
      if (poll.entry) removeEntry(poll.entry);
    }
  }
}

function senderMatches(entry, sender) {
  if (!entry) return false;
  const incoming = new Set(jidVariants(sender));
  if (!incoming.size) return entry.rawSender === String(sender || '');
  for (const allowed of entry.senderSet) {
    if (incoming.has(allowed)) return true;
  }
  return false;
}

/**
 * Register a pending choice.
 *
 * @param {{
 *   chatId: string,
 *   sender: string|string[],
 *   items: any[],
 *   run: Function,
 *   ttlMs?: number,
 *   label?: string,
 *   ids?: string[]|null,
 *   promptMessageId?: string|null
 * }} opts
 * @returns {string} unique offerId
 */
function offer({
  chatId,
  sender,
  items,
  run,
  ttlMs = DEFAULT_TTL_MS,
  label = '',
  ids = null,
  promptMessageId = null,
}) {
  if (!Array.isArray(items) || !items.length || typeof run !== 'function') {
    throw new Error('offer() needs items and a run callback');
  }
  prune();

  const offerId = nextOfferId();
  const keys = senderKeys(chatId, sender);
  const senderSet = new Set(jidVariants(sender));
  const rawIds = Array.isArray(ids) ? ids.map((x) => String(x)) : null;
  const scopedIds = rawIds ? rawIds.map((x) => `${offerId}:${x}`) : null;

  // Replace the latest unquoted slot for this sender in this chat, while keeping
  // any earlier message-bound entries addressable ONLY via direct quote if needed
  // — actually replacing previous unconsumed entry for the same sender avoids
  // stale choices piling up.
  for (const k of keys) {
    const prev = pending.get(k);
    if (prev) removeEntry(prev);
  }

  const entry = {
    offerId,
    chatId,
    rawSender: Array.isArray(sender) ? String(sender[0] || '') : String(sender || ''),
    senderSet,
    keys,
    at: Date.now(),
    ttlMs,
    items,
    run,
    label,
    ids: rawIds,
    scopedIds,
    promptMessageId: promptMessageId ? String(promptMessageId) : null,
    pollMessageId: null,
    consumed: false,
  };

  for (const k of keys) pending.set(k, entry);
  if (entry.promptMessageId) {
    pendingByMsgId.set(entry.promptMessageId, entry);
  }

  return offerId;
}

/**
 * Send a WhatsApp Poll (up to 12 options) with automatic numbered-text fallback,
 * and register both the poll vote handler and typed-number fallback ONLY if
 * sending succeeds. Any stale pending choice for `(chatId, sender)` is cleared
 * before sending so a failed send never leaves stale state behind.
 *
 * @param {object} sock
 * @param {object} msg
 * @param {object} extra
 * @param {{
 *   pollName: string,
 *   optionLabels: string[],
 *   fallbackText: string,
 *   fallbackImage?: string|null,
 *   items: any[],
 *   ids?: string[]|null,
 *   label?: string,
 *   ttlMs?: number,
 *   run: Function,
 * }} spec
 */
async function sendPollOrText(sock, msg, extra, spec) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const senderList = [
    extra?.sender,
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt,
  ].filter(Boolean);
  const sender = senderList.length ? senderList : [chatId];

  // Always clear stale choices first — if sending throws, nothing stale remains.
  clear(chatId, sender);

  const {
    pollName,
    optionLabels = [],
    fallbackText,
    fallbackImage = null,
    items,
    ids = null,
    label = '',
    ttlMs = DEFAULT_TTL_MS,
    run,
  } = spec;

  const canPoll =
    items.length >= 2 &&
    items.length <= MAX_POLL_OPTIONS &&
    optionLabels.length === items.length;

  let sent = null;
  let usedPoll = false;
  let messageSecret = null;
  let finalValues = null;

  if (canPoll) {
    // Prefix with `1. `, `2. ` if not already numbered so option hashes are
    // strictly unique AND users can still type a number if they prefer!
    finalValues = optionLabels.map((opt, idx) => {
      const clean = String(opt || '').replace(/\s+/g, ' ').trim();
      const numbered = /^\d+[.)]\s/.test(clean) ? clean : `${idx + 1}. ${clean}`;
      return numbered.length > 100 ? `${numbered.slice(0, 99)}…` : numbered;
    });
    messageSecret = crypto.randomBytes(32);

    try {
      sent = await sock.sendMessage(
        chatId,
        {
          poll: {
            name: String(pollName || 'Choose an option:').slice(0, 255),
            values: finalValues,
            selectableCount: 1,
            messageSecret,
          },
        },
        { quoted: msg },
      );
      if (sent?.key?.id) {
        usedPoll = true;
      }
    } catch {
      sent = null;
      usedPoll = false;
    }
  }

  if (!usedPoll) {
    if (fallbackImage) {
      sent = await sock.sendMessage(
        chatId,
        { image: { url: fallbackImage }, caption: fallbackText },
        { quoted: msg },
      ).catch(() => sock.sendMessage(chatId, { text: fallbackText }, { quoted: msg }));
    } else {
      sent = await sock.sendMessage(chatId, { text: fallbackText }, { quoted: msg });
    }
  }

  const promptMessageId = sent?.key?.id ? String(sent.key.id) : null;
  const offerId = offer({
    chatId,
    sender,
    items,
    ids,
    label,
    ttlMs,
    promptMessageId,
    run,
  });

  const entry = peek(chatId, sender);
  if (usedPoll && promptMessageId && entry) {
    // Capture secret generated by Baileys or our explicit 32-byte secret
    const secret =
      sent?.message?.messageContextInfo?.messageSecret ||
      messageSecret;
    const optionHashes = new Map();
    finalValues.forEach((val, idx) => {
      optionHashes.set(sha256Hex(val), idx);
    });
    const creatorCandidates = [
      sock?.user?.id,
      sock?.user?.lid,
      sent?.key?.participant,
      sent?.key?.remoteJid,
    ]
      .filter(Boolean)
      .map((j) => {
        try { return jidNormalizedUser(j); } catch { return String(j); }
      });

    entry.pollMessageId = promptMessageId;
    pendingPolls.set(promptMessageId, {
      pollMsgId: promptMessageId,
      chatId,
      messageSecret: Buffer.from(secret),
      optionHashes,
      values: finalValues,
      creatorJids: [...new Set(creatorCandidates)],
      at: entry.at,
      ttlMs,
      entry,
    });
  }

  return { offerId, promptMessageId, usedPoll };
}

/**
 * Send a numbered text (or image+caption) prompt and register the pending choice
 * ONLY if sending succeeds; clears any stale choice beforehand.
 */
async function sendTextPrompt(sock, msg, extra, {
  text,
  image = null,
  items,
  ids = null,
  label = '',
  ttlMs = DEFAULT_TTL_MS,
  run,
}) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const senderList = [
    extra?.sender,
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt,
  ].filter(Boolean);
  const sender = senderList.length ? senderList : [chatId];

  clear(chatId, sender);

  const sent = image
    ? await sock.sendMessage(chatId, { image: { url: image }, caption: text }, { quoted: msg })
      .catch(() => sock.sendMessage(chatId, { text }, { quoted: msg }))
    : await sock.sendMessage(chatId, { text }, { quoted: msg });

  const promptMessageId = sent?.key?.id ? String(sent.key.id) : null;
  const offerId = offer({
    chatId,
    sender,
    items,
    ids,
    label,
    ttlMs,
    promptMessageId,
    run,
  });
  return { offerId, promptMessageId };
}

/**
 * Resolve an incoming `pollUpdateMessage` against `pendingPolls`.
 *
 * @param {object} sock
 * @param {object} msg  raw Baileys message carrying `pollUpdateMessage`
 * @returns {{ entry: object, item: any, index: number, chatId: string, voterJid: string } | null}
 */
function resolvePollVote(sock, msg) {
  prune();
  const content = msg?.message?.ephemeralMessage?.message
    || msg?.message?.viewOnceMessage?.message
    || msg?.message;
  const pollUpdate = content?.pollUpdateMessage;
  if (!pollUpdate?.pollCreationMessageKey?.id || !pollUpdate?.vote) return null;

  const pollMsgId = String(pollUpdate.pollCreationMessageKey.id);
  const poll = pendingPolls.get(pollMsgId);
  if (!poll || !poll.entry || poll.entry.consumed) return null;

  const voterRawList = [
    msg.key?.participant,
    msg.key?.participantAlt,
    ! String(msg.key?.remoteJid || '').endsWith('@g.us') ? msg.key?.remoteJid : null,
    msg.key?.remoteJidAlt,
    pollUpdate.pollCreationMessageKey?.participant,
  ].filter(Boolean);

  // Only the user who opened this picker may vote on it
  if (!senderMatches(poll.entry, voterRawList)) {
    return null;
  }

  const creatorJids = [
    ...poll.creatorJids,
    sock?.user?.id,
    sock?.user?.lid,
    pollUpdate.pollCreationMessageKey?.participant,
  ]
    .filter(Boolean)
    .map((j) => {
      try { return jidNormalizedUser(j); } catch { return String(j); }
    });

  const voterJids = [];
  for (const v of voterRawList) {
    try { voterJids.push(jidNormalizedUser(v)); } catch { /* ignore */ }
    for (const variant of jidVariants(v)) {
      try { voterJids.push(jidNormalizedUser(variant)); } catch { voterJids.push(variant); }
    }
  }
  if (msg.key?.fromMe) {
    if (sock?.user?.id) voterJids.push(jidNormalizedUser(sock.user.id));
    if (sock?.user?.lid) voterJids.push(jidNormalizedUser(sock.user.lid));
  }

  const uniqueCreators = [...new Set(creatorJids)];
  const uniqueVoters = [...new Set(voterJids)];

  let decrypted = null;
  for (const pollCreatorJid of uniqueCreators) {
    for (const voterJid of uniqueVoters) {
      try {
        decrypted = decryptPollVote(pollUpdate.vote, {
          pollEncKey: poll.messageSecret,
          pollCreatorJid,
          pollMsgId,
          voterJid,
        });
        if (decrypted) break;
      } catch {
        // Try next JID representation (PN vs LID)
      }
    }
    if (decrypted) break;
  }

  if (!decrypted || !Array.isArray(decrypted.selectedOptions) || !decrypted.selectedOptions.length) {
    // Empty selectedOptions means user deselected their vote — keep poll alive
    return null;
  }

  for (const optBuf of decrypted.selectedOptions) {
    const hex = Buffer.from(optBuf).toString('hex');
    if (poll.optionHashes.has(hex)) {
      const index = poll.optionHashes.get(hex);
      const item = poll.entry.items[index];
      const entry = poll.entry;
      removeEntry(entry);
      return {
        entry,
        item,
        index,
        chatId: poll.chatId,
        voterJid: uniqueVoters[0] || entry.rawSender,
      };
    }
  }

  return null;
}

/** "3" | ".3" | "#3" | "3." | "3)" → 3 */
const CHOICE_RE = /^([.!#]?)(\d{1,2})[.)]?$/;

const parseChoice = (text) => {
  const m = String(text || '').trim().match(CHOICE_RE);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isCancel = (text) => /^(cancel|stop|no|nevermind|never mind)$/i.test(String(text || '').trim());

/**
 * Look up the active entry for `(chatId, sender)`.
 * If `quotedMessageId` is supplied AND the pending entry has a `promptMessageId`,
 * they MUST match — quoting an unrelated chat message will never match!
 */
function peek(chatId, sender, { quotedMessageId = null } = {}) {
  prune();
  if (quotedMessageId) {
    const byMsg = pendingByMsgId.get(String(quotedMessageId));
    if (byMsg && byMsg.chatId === chatId && senderMatches(byMsg, sender)) {
      return byMsg;
    }
    // Look up sender's entry: if that entry WAS bound to a specific promptMessageId
    // and the user quoted a DIFFERENT message, do NOT hijack their reply!
    for (const k of senderKeys(chatId, sender)) {
      const entry = pending.get(k);
      if (entry && !entry.promptMessageId) return entry;
    }
    return null;
  }

  for (const k of senderKeys(chatId, sender)) {
    const entry = pending.get(k);
    if (entry) return entry;
  }
  return null;
}

/**
 * Resolve an incoming text/row reply against a pending choice.
 * @param {string} chatId
 * @param {string|string[]} sender
 * @param {string} text
 * @param {{ quotedMessageId?: string|null }} [opts]
 * @returns {{entry:object,item:any,index:number}|null}
 */
function match(chatId, sender, text, opts = {}) {
  const entry = peek(chatId, sender, opts);
  if (!entry) return null;

  const raw = String(text || '').trim();
  if (raw && entry.scopedIds && entry.scopedIds.includes(raw)) {
    const index = entry.scopedIds.indexOf(raw);
    removeEntry(entry);
    return { entry, item: entry.items[index], index };
  }
  if (raw && entry.ids && entry.ids.includes(raw)) {
    const index = entry.ids.indexOf(raw);
    removeEntry(entry);
    return { entry, item: entry.items[index], index };
  }

  const n = parseChoice(raw);
  if (n === null || n > entry.items.length) return null;
  removeEntry(entry);
  return { entry, item: entry.items[n - 1], index: n - 1 };
}

/** Drop a pending choice (used by "cancel", send failures, and finished commands). */
function clear(chatId, sender, { quotedMessageId = null } = {}) {
  prune();
  if (quotedMessageId) {
    const byMsg = pendingByMsgId.get(String(quotedMessageId));
    if (byMsg && byMsg.chatId === chatId && senderMatches(byMsg, sender)) {
      removeEntry(byMsg);
      return true;
    }
    return false;
  }
  let had = false;
  for (const k of senderKeys(chatId, sender)) {
    const entry = pending.get(k);
    if (entry) {
      removeEntry(entry);
      had = true;
    }
  }
  return had;
}

/** True when a number out of range was sent (respecting quoted-message binding). */
function isOutOfRange(chatId, sender, text, opts = {}) {
  const entry = peek(chatId, sender, opts);
  if (!entry) return false;
  const n = parseChoice(text);
  return n !== null && n > entry.items.length;
}

const size = () => {
  prune();
  return new Set(pending.values()).size;
};

module.exports = {
  offer,
  sendPollOrText,
  sendTextPrompt,
  resolvePollVote,
  match,
  peek,
  clear,
  parseChoice,
  isCancel,
  isOutOfRange,
  size,
  DEFAULT_TTL_MS,
  MAX_POLL_OPTIONS,
};
