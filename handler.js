/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const selections = require('./utils/selections');
const { loadCommands } = require('./utils/commandLoader');
const { jidVariants } = require('./utils/jid');
const { readWL, findAllowedUserIndex } = require('./utils/accessControl');
const { safeErrorMessage } = require('./utils/userErrors');

// Load all commands
const commands = loadCommands();

// Unwrap WhatsApp containers (ephemeral, view once, …).
// Deliberately excludes `editedMessage`: edited messages must NOT re-trigger commands.
const CONTAINER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
];

const isEditedMessage = (msg) => {
  if (!msg || !msg.message) return false;
  let m = msg.message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.editedMessage) return true;
    if (m.protocolMessage?.editedMessage || m.protocolMessage?.type === 14) return true;
    const nextKey = CONTAINER_KEYS.find((k) => m[k] && m[k].message);
    if (!nextKey) break;
    m = m[nextKey].message;
  }
  return false;
};

const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;
  let m = msg.message;
  for (let i = 0; i < 5; i++) {
    const key = CONTAINER_KEYS.find(k => m && m[k] && m[k].message);
    if (!key) break;
    m = m[key].message;
  }
  return m || null;
};

// Owners and hardcoded bot admins (matches PN or LID forms of the sender)
const isOwner = (ids) => {
  const sender = jidVariants(ids);
  if (!sender.size) return false;
  return [...config.ownerNumber, ...(config.adminNumbers || [])].some(n => {
    const staff = jidVariants(`${n}@s.whatsapp.net`);
    return [...staff].some(x => sender.has(x));
  });
};

// Owner/admin or whitelisted user — everyone else gets no response at all
const isAllowedSender = (ids) => {
  if (isOwner(ids)) return true;
  try {
    // enabled:false (dashboard "Disallow") = present but blocked
    return findAllowedUserIndex(readWL().users, ids) !== -1;
  } catch {
    return false;
  }
};

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || 
         jid.includes('status.broadcast') || 
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Per-user command cooldown (`canonicalUserKey -> lastRunMs`) so a user cannot
// rapid-fire expensive commands. Owners are exempt.
const userCooldowns = new Map();
const cooldownKeyOf = (senderIds, fallback) => {
  for (const id of senderIds || []) {
    const clean = String(id || '').split(':')[0].split('@')[0];
    if (clean) return clean;
  }
  return String(fallback || '');
};
const checkCooldown = (senderIds, sender) => {
  if (isOwner(senderIds)) return { limited: false, waitMs: 0 };
  const windowMs = Math.max(0, Number(config.cooldownMs ?? 2000));
  if (!windowMs) return { limited: false, waitMs: 0 };

  const now = Date.now();
  if (userCooldowns.size > 500) {
    for (const [k, ts] of userCooldowns) {
      if (now - ts > windowMs * 2) userCooldowns.delete(k);
    }
  }
  const key = cooldownKeyOf(senderIds, sender);
  const prev = userCooldowns.get(key) || 0;
  if (now - prev < windowMs) {
    return { limited: true, waitMs: windowMs - (now - prev) };
  }
  userCooldowns.set(key, now);
  return { limited: false, waitMs: 0 };
};
const resetCooldowns = () => userCooldowns.clear();

// Every command receives this bag of helpers.
const buildExtra = (sock, msg, { from, sender, senderIds, commandName = '' }) => ({
  from,
  sender,
  commandName,
  isOwner: isOwner(senderIds),
  reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
  // Send an initial status message, then edit it in place with the final
  // result. Usage:
  //   const status = await extra.status('🔍 Searching...');
  //   await status.update('📚 Found *3 papers* for *CHEM 3601*');
  status: async (initialText) => {
    const sent = await sock.sendMessage(from, { text: initialText }, { quoted: msg });
    return {
      // Editing can fail (old WhatsApp version / rate limit) — fall back to
      // a normal message so the user always gets the final result.
      update: async (finalText) => {
        try {
          return await sock.sendMessage(from, { text: finalText, edit: sent.key });
        } catch (e) {
          return sock.sendMessage(from, { text: finalText }, { quoted: msg });
        }
      },
    };
  },
});

// Extract the stanzaId of any message quoted by `content`, if present.
const getQuotedMessageId = (content) =>
  content?.extendedTextMessage?.contextInfo?.stanzaId ||
  content?.imageMessage?.contextInfo?.stanzaId ||
  content?.videoMessage?.contextInfo?.stanzaId ||
  content?.documentMessage?.contextInfo?.stanzaId ||
  null;

// Execute an explicitly prefixed command. Unknown commands are ignored.
async function runCommand(sock, msg, name, args, { from, sender, senderIds }) {
  const invoked = String(name || '').toLowerCase();
  const command = commands.get(invoked);
  if (!command) return false;

  if (command.ownerOnly && !isOwner(senderIds)) {
    await sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    return true;
  }

  const cd = checkCooldown(senderIds, sender);
  if (cd.limited) {
    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } }).catch(() => {});
    return true;
  }

  console.log(`Executing command: ${invoked} from ${sender}`);
  await command.execute(
    sock,
    msg,
    args || [],
    buildExtra(sock, msg, { from, sender, senderIds, commandName: invoked }),
  );
  return true;
}

// "Reply with a number" answers are not commands, so they are resolved here.
async function handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId = null }) {
  const opts = { quotedMessageId };
  const open = selections.peek(from, senderIds, opts);
  if (!open) return false; // nothing pending → "no"/"stop" stay ordinary text

  if (selections.isCancel(body)) {
    selections.clear(from, senderIds, opts);
    await sock.sendMessage(from, { text: '👍 Cancelled. Nothing was downloaded.' }, { quoted: msg });
    return true;
  }

  const picked = selections.match(from, senderIds, body, opts);
  if (picked) {
    try {
      await picked.entry.run(sock, msg, buildExtra(sock, msg, { from, sender, senderIds }), picked.item);
    } catch (e) {
      console.error('Error running selection:', e.message);
      try {
        await sock.sendMessage(
          from,
          { text: safeErrorMessage(e, { isOwner: isOwner(senderIds) }) },
          { quoted: msg },
        );
      } catch { /* ignore */ }
    }
    return true;
  }

  // A number that no longer matches anything (expired, or too big)
  if (selections.isOutOfRange(from, senderIds, body, opts)) {
    await sock.sendMessage(from, {
      text: `❌ Pick a number between 1 and ${open.items.length}, or reply *cancel*.`,
    }, { quoted: msg });
    return true;
  }

  return false;
}

// Main message handler
const handleMessage = async (sock, msg) => {
  try {
    if (!msg.message) return;
    if (isEditedMessage(msg)) return;

    const from = msg.key.remoteJid;
    if (isSystemJid(from)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
    if (Object.keys(content).filter(k => !protocolMessages.includes(k)).length === 0) return;

    const sender = msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid;
    // Every JID form WhatsApp gave us for this sender (LID and phone number)
    const senderIds = [sender, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean);

    // ── Gates ─────────────────────────────────────────────────────────────
    // Bot on/off, then permission: owner bypasses, everyone else must be
    // allowed via .allow. Non-allowed users get no response at all.
    if (!database.getBotState() && !isOwner(senderIds)) return;
    if (!isAllowedSender(senderIds)) return;

    // ── Poll votes (`pollUpdateMessage`) ──────────────────────────────────
    if (content.pollUpdateMessage) {
      const voteHit = selections.resolvePollVote(sock, msg);
      if (voteHit) {
        const pollKey = content.pollUpdateMessage.pollCreationMessageKey || msg.key;
        const quoteMsg = { key: { ...pollKey, remoteJid: voteHit.chatId } };
        try {
          await voteHit.entry.run(
            sock,
            quoteMsg,
            buildExtra(sock, quoteMsg, { from: voteHit.chatId, sender, senderIds }),
            voteHit.item,
          );
        } catch (e) {
          console.error('Error running poll selection:', e.message);
          try {
            await sock.sendMessage(
              voteHit.chatId,
              { text: safeErrorMessage(e, { isOwner: isOwner(senderIds) }) },
            );
          } catch { /* ignore */ }
        }
      }
      return;
    }

    // Get message body from unwrapped content
    let body = '';
    if (content.conversation) {
      body = content.conversation;
    } else if (content.extendedTextMessage) {
      body = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption || '';
    } else if (content.documentMessage) {
      body = content.documentMessage.caption || '';
    } else if (content.buttonsResponseMessage) {
      body = content.buttonsResponseMessage.selectedButtonId || '';
    } else if (content.listResponseMessage) {
      body = content.listResponseMessage.singleSelectReply?.selectedRowId || '';
    }
    body = (body || '').trim();

    const quotedMessageId = getQuotedMessageId(content);

    // "Reply with a number" for a command that offered a list
    if (await handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId })) return;

    // Ignore ordinary text; only explicitly prefixed commands are executed.
    if (!body.startsWith(config.prefix)) return;

    const commandText = body.slice(config.prefix.length).trim();
    if (!commandText) return;
    const args = commandText.split(/\s+/);
    await runCommand(sock, msg, args.shift(), args, { from, sender, senderIds });

  } catch (error) {
    console.error('Error in message handler:', error);

    // Don't send error messages for rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      console.warn('⚠️ Rate limit reached. Skipping error message.');
      return;
    }

    try {
      // Never leak stack traces, paths, or internal error text into the chat.
      const sender = msg.key.fromMe
        ? (sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.remoteJid)
        : msg.key.participant || msg.key.remoteJid;
      const senderIds = [sender, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean);
      await sock.sendMessage(msg.key.remoteJid, {
        text: safeErrorMessage(error, { isOwner: isOwner(senderIds) }),
      }, { quoted: msg });
    } catch (e) {
      if (!e.message || !e.message.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

module.exports = {
  handleMessage,
  isEditedMessage,
  isSystemJid,
  resetCooldowns,
};
