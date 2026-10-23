/**
 * ZaFar Bot — Interactive Selector (`single_select`), Polls & Pending Choices
 *
 * Primary UX on live WhatsApp sockets (`sock.relayMessage`):
 *   • Native Flow `single_select` bottom-sheet selector (`interactiveMessage` +
 *     `<biz><interactive type="native_flow">`), so users simply tap a button
 *     and tap the movie / series / quality they want.
 *
 * Automatic fallbacks:
 *   • WhatsApp Poll (`pollCreationMessageV3` → `pollUpdateMessage`) when
 *     `relayMessage` is unavailable (e.g. unit-test sockets) or fails.
 *   • Clean numbered text card when >24 items or polls are unsupported.
 *   • Typed numbers ("1", "2", "#2") always work alongside tap selectors.
 */

const crypto = require('crypto');
const {
  proto,
  generateWAMessageFromContent,
  normalizeMessageContent,
  getContentType,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { decryptPollVote } = require('@whiskeysockets/baileys/lib/Utils/process-message');
const { jidVariants } = require('./jid');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_POLL_OPTIONS = 12;
const MAX_SELECTOR_ROWS = 24;

const BIZ_NATIVE_FLOW_NODE = {
  tag: 'biz',
  attrs: {},
  content: [
    {
      tag: 'interactive',
      attrs: { type: 'native_flow', v: '1' },
      content: [
        {
          tag: 'native_flow',
          attrs: { v: '9', name: 'mixed' },
        },
      ],
    },
  ],
};

let _seq = 0;
const nextOfferId = () => `sel_${++_seq}_${Date.now().toString(36)}`;

// Latest pending choice per `${chatId}:${canonicalSender}` -> entry
const pending = new Map();
// Prompt message ID -> entry (lets quoted replies target the exact prompt)
const pendingByMsgId = new Map();
// Offer ID -> entry (lets `sel_<id>:<row>` taps resolve directly)
const pendingByOfferId = new Map();
// Poll message ID -> poll entry (for `pollUpdateMessage` vote decryption)
const pendingPolls = new Map();

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/**
 * Guard `{ quoted: msg }` so Baileys' `generateWAMessageFromContent` never
 * crashes with `Cannot read properties of undefined (reading 'undefined')`
 * when a synthetic or poll-vote message lacks `.message`.
 */
function canQuote(msg) {
  if (!msg || !msg.key || !msg.message) return false;
  try {
    const inner = normalizeMessageContent(msg.message);
    return Boolean(inner && getContentType(inner));
  } catch {
    return false;
  }
}

function quoteOpts(msg) {
  return canQuote(msg) ? { quoted: msg } : {};
}

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
  if (entry.offerId && pendingByOfferId.get(entry.offerId) === entry) {
    pendingByOfferId.delete(entry.offerId);
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
  for (const [id, entry] of pendingByOfferId) {
    if (entry.consumed || now - entry.at > entry.ttlMs) {
      pendingByOfferId.delete(id);
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
  offerId: explicitOfferId = null,
  originMsg = null,
}) {
  if (!Array.isArray(items) || !items.length || typeof run !== 'function') {
    throw new Error('offer() needs items and a run callback');
  }
  prune();

  const offerId = explicitOfferId || nextOfferId();
  const keys = senderKeys(chatId, sender);
  const senderSet = new Set(jidVariants(sender));
  const rawIds = Array.isArray(ids) && ids.length === items.length
    ? ids.map((x) => String(x))
    : items.map((_, i) => String(i));
  const scopedIds = rawIds.map((x) => `${offerId}:${x}`);

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
    ids: Array.isArray(ids) ? ids.map((x) => String(x)) : null,
    scopedIds,
    promptMessageId: promptMessageId ? String(promptMessageId) : null,
    pollMessageId: null,
    originMsg: canQuote(originMsg) ? originMsg : null,
    consumed: false,
  };

  for (const k of keys) pending.set(k, entry);
  pendingByOfferId.set(offerId, entry);
  if (entry.promptMessageId) {
    pendingByMsgId.set(entry.promptMessageId, entry);
  }

  return offerId;
}

/**
 * Extract selected row ID or text from an incoming `interactiveResponseMessage`.
 */
function extractInteractiveSelection(content) {
  const irm = content?.interactiveResponseMessage;
  if (!irm) return '';
  const rawJson = irm.nativeFlowResponseMessage?.paramsJson;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      const id = parsed?.id || parsed?.selectedId || parsed?.rowId || '';
      if (id) return String(id).trim();
    } catch { /* fall through */ }
  }
  return String(irm.body?.text || '').trim();
}

/**
 * Send a Native Flow `single_select` tap selector on live WhatsApp sockets,
 * falling back cleanly to a WhatsApp Poll or numbered text card.
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

  // Clear stale choices first so a failed send never leaves stale state behind.
  clear(chatId, sender);

  const {
    pollName,
    optionLabels = [],
    fallbackText,
    fallbackImage = null,
    selector = null,
    items,
    ids = null,
    label = '',
    ttlMs = DEFAULT_TTL_MS,
    run,
  } = spec;

  const preOfferId = nextOfferId();
  const rawIds = Array.isArray(ids) && ids.length === items.length
    ? ids.map((x) => String(x))
    : items.map((_, i) => String(i));
  const scopedIds = rawIds.map((x) => `${preOfferId}:${x}`);

  let sent = null;
  let usedSelector = false;
  let usedPoll = false;
  let messageSecret = null;
  let finalValues = null;

  // ── 1. Primary: Native Flow `single_select` tap-to-select drawer ─────────
  const canSelector =
    typeof sock?.relayMessage === 'function' &&
    Boolean(sock?.user?.id) &&
    items.length >= 2 &&
    items.length <= MAX_SELECTOR_ROWS &&
    (selector?.rows?.length === items.length || optionLabels.length === items.length);

  if (canSelector) {
    try {
      const rawLines = String(pollName || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const headerTitle = String(selector?.headerTitle || rawLines[0] || 'Select an option')
        .replace(/\*/g, '')
        .slice(0, 60);
      const bodyText = String(
        selector?.bodyText ||
        (rawLines.length > 1 ? rawLines.slice(1).join('\n') : rawLines[0]) ||
        'Tap below to select:',
      ).slice(0, 1024);
      const footerText = String(selector?.footerText || 'Tap below or reply with a number').slice(0, 60);
      const buttonText = String(selector?.buttonText || 'Tap to Select').slice(0, 20);
      const sectionTitle = String(selector?.sectionTitle || 'Options').slice(0, 24);

      const rows = items.map((_, idx) => {
        const custom = selector?.rows?.[idx];
        const fallbackLbl = String(optionLabels[idx] || `Option ${idx + 1}`).replace(/\s+/g, ' ').trim();
        const title = String(custom?.title || fallbackLbl).slice(0, 60);
        const description = String(custom?.description || '').slice(0, 72);
        return {
          header: '',
          title,
          description,
          id: scopedIds[idx],
        };
      });

      const waMsg = generateWAMessageFromContent(
        chatId,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
                messageSecret: crypto.randomBytes(32),
              },
              interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                header: {
                  title: headerTitle,
                  hasMediaAttachment: false,
                },
                body: {
                  text: bodyText,
                },
                footer: {
                  text: footerText,
                },
                nativeFlowMessage: {
                  buttons: [
                    {
                      name: 'single_select',
                      buttonParamsJson: JSON.stringify({
                        title: buttonText,
                        sections: [
                          {
                            title: sectionTitle,
                            rows,
                          },
                        ],
                      }),
                    },
                  ],
                  messageParamsJson: '',
                },
              }),
            },
          },
        },
        {
          userJid: sock.user.id,
          ...quoteOpts(msg),
        },
      );

      await sock.relayMessage(chatId, waMsg.message, {
        messageId: waMsg.key.id,
        additionalNodes: [BIZ_NATIVE_FLOW_NODE],
      });

      sent = waMsg;
      usedSelector = true;
    } catch {
      sent = null;
      usedSelector = false;
    }
  }

  // ── 2. Fallback: WhatsApp Poll (unit-test mocks or if relayMessage fails) ─
  const canPoll =
    !usedSelector &&
    items.length >= 2 &&
    items.length <= MAX_POLL_OPTIONS &&
    optionLabels.length === items.length;

  if (canPoll) {
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
        quoteOpts(msg),
      );
      if (sent?.key?.id) {
        usedPoll = true;
      }
    } catch {
      sent = null;
      usedPoll = false;
    }
  }

  // ── 3. Fallback: Numbered text card ──────────────────────────────────────
  if (!usedSelector && !usedPoll) {
    if (fallbackImage) {
      sent = await sock.sendMessage(
        chatId,
        { image: { url: fallbackImage }, caption: fallbackText },
        quoteOpts(msg),
      ).catch(() => sock.sendMessage(chatId, { text: fallbackText }, quoteOpts(msg)));
    } else {
      sent = await sock.sendMessage(chatId, { text: fallbackText }, quoteOpts(msg));
    }
  }

  const promptMessageId = sent?.key?.id ? String(sent.key.id) : null;
  const offerId = offer({
    offerId: preOfferId,
    chatId,
    sender,
    items,
    ids,
    label,
    ttlMs,
    promptMessageId,
    originMsg: canQuote(msg) ? msg : sent,
    run,
  });

  const entry = pendingByOfferId.get(offerId);
  if (usedPoll && promptMessageId && entry) {
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
      sentMsg: canQuote(sent) ? sent : null,
      at: entry.at,
      ttlMs,
      entry,
    });
  }

  return { offerId, promptMessageId, usedSelector, usedPoll };
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

  const qOpts = quoteOpts(msg);
  const sent = image
    ? await sock.sendMessage(chatId, { image: { url: image }, caption: text }, qOpts)
      .catch(() => sock.sendMessage(chatId, { text }, qOpts))
    : await sock.sendMessage(chatId, { text }, qOpts);

  const promptMessageId = sent?.key?.id ? String(sent.key.id) : null;
  const offerId = offer({
    chatId,
    sender,
    items,
    ids,
    label,
    ttlMs,
    promptMessageId,
    originMsg: canQuote(msg) ? msg : sent,
    run,
  });
  return { offerId, promptMessageId };
}

/**
 * Resolve an incoming `pollUpdateMessage` against `pendingPolls`.
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
    !String(msg.key?.remoteJid || '').endsWith('@g.us') ? msg.key?.remoteJid : null,
    msg.key?.remoteJidAlt,
    pollUpdate.pollCreationMessageKey?.participant,
  ].filter(Boolean);

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
    return null;
  }

  for (const optBuf of decrypted.selectedOptions) {
    const hex = Buffer.from(optBuf).toString('hex');
    if (poll.optionHashes.has(hex)) {
      const index = poll.optionHashes.get(hex);
      const item = poll.entry.items[index];
      const entry = poll.entry;
      const originMsg =
        entry.originMsg ||
        poll.sentMsg || {
          key: {
            ...(pollUpdate.pollCreationMessageKey || msg.key),
            remoteJid: poll.chatId,
          },
          message: { conversation: poll.values?.[index] || entry.label || 'Selected' },
        };
      removeEntry(entry);
      return {
        entry,
        item,
        index,
        chatId: poll.chatId,
        voterJid: uniqueVoters[0] || entry.rawSender,
        originMsg,
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
function peek(chatId, sender, { quotedMessageId = null, rawText = null } = {}) {
  prune();
  if (rawText) {
    const m = /^((?:sel)_\d+_[a-z0-9]+):/i.exec(String(rawText).trim());
    if (m) {
      const byOffer = pendingByOfferId.get(m[1]);
      if (byOffer && byOffer.chatId === chatId && senderMatches(byOffer, sender)) {
        return byOffer;
      }
    }
  }

  if (quotedMessageId) {
    const byMsg = pendingByMsgId.get(String(quotedMessageId));
    if (byMsg && byMsg.chatId === chatId && senderMatches(byMsg, sender)) {
      return byMsg;
    }
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
 * Resolve an incoming tap/row/number reply against a pending choice.
 */
function match(chatId, sender, text, opts = {}) {
  const raw = String(text || '').trim();
  const entry = peek(chatId, sender, { ...opts, rawText: raw });
  if (!entry) return null;

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
  sendSelector: sendPollOrText,
  sendPollOrText,
  sendTextPrompt,
  extractInteractiveSelection,
  resolvePollVote,
  canQuote,
  quoteOpts,
  match,
  peek,
  clear,
  parseChoice,
  isCancel,
  isOutOfRange,
  size,
  DEFAULT_TTL_MS,
  MAX_POLL_OPTIONS,
  MAX_SELECTOR_ROWS,
};
