/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const selections = require('./utils/selections');
const { loadCommands } = require('./utils/commandLoader');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const { jidVariants } = require('./utils/jid');
const { readWL, findUserIndex } = require('./utils/accessControl');

// Load all commands
const commands = loadCommands();

// Unwrap WhatsApp containers (ephemeral, view once, edited, …).
// Loops because containers nest (e.g. viewOnce inside ephemeral).
const CONTAINER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
];

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
  return findUserIndex(readWL().users, ids) !== -1;
};

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || 
         jid.includes('status.broadcast') || 
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Every command receives this bag of helpers.
const buildExtra = (sock, msg, { from, sender, senderIds }) => ({
  from,
  sender,
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

// Execute an explicitly prefixed command. Unknown commands are ignored.
async function runCommand(sock, msg, name, args, { from, sender, senderIds }) {
  const command = commands.get(String(name || '').toLowerCase());
  if (!command) return false;

  if (command.ownerOnly && !isOwner(senderIds)) {
    await sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    return true;
  }

  console.log(`Executing command: ${String(name).toLowerCase()} from ${sender}`);
  await command.execute(sock, msg, args || [], buildExtra(sock, msg, { from, sender, senderIds }));
  return true;
}

// "Reply with a number" answers are not commands, so they are resolved here.
async function handleSelection(sock, msg, body, { from, sender, senderIds }) {
  const open = selections.peek(from, sender);
  if (!open) return false; // nothing pending → "no"/"stop" stay ordinary text

  if (selections.isCancel(body)) {
    selections.clear(from, sender);
    await sock.sendMessage(from, { text: '👍 Cancelled. Nothing was downloaded.' }, { quoted: msg });
    return true;
  }

  const picked = selections.match(from, sender, body);
  if (picked) {
    try {
      await picked.entry.run(sock, msg, buildExtra(sock, msg, { from, sender, senderIds }), picked.item);
    } catch (e) {
      console.error('Error running selection:', e.message);
      try {
        await sock.sendMessage(from, { text: `${config.messages.error}\n_${String(e.message || '').split('\n')[0].slice(0, 140)}_` }, { quoted: msg });
      } catch { /* ignore */ }
    }
    return true;
  }

  // A number that no longer matches anything (expired, or too big)
  if (selections.isOutOfRange(from, sender, body)) {
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

    const from = msg.key.remoteJid;
    if (isSystemJid(from)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
    if (Object.keys(content).filter(k => !protocolMessages.includes(k)).length === 0) return;

    // jidNormalizedUser strips the device suffix ("123:4@s.whatsapp.net") and
    // never doubles the server part when the id has no device suffix.
    const sender = msg.key.fromMe ? jidNormalizedUser(sock.user.id) : msg.key.participant || msg.key.remoteJid;
    // Every JID form WhatsApp gave us for this sender (LID and phone number)
    const senderIds = [sender, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean);

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

    // ── Gates ─────────────────────────────────────────────────────────────
    // Bot on/off, then permission: owner bypasses, everyone else must be
    // allowed via .allow. Non-allowed users get no response at all.
    if (!database.getBotState() && !isOwner(senderIds)) return;
    if (!isAllowedSender(senderIds)) return;

    // "Reply with a number" for a command that offered a list
    if (await handleSelection(sock, msg, body, { from, sender, senderIds })) return;

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
      // Never leak stack traces / internal paths into the chat: a short reason
      // is useful, everything else stays in the log.
      const reason = String(error.message || '').split('\n')[0].slice(0, 140);
      await sock.sendMessage(msg.key.remoteJid, {
        text: reason ? `${config.messages.error}\n_${reason}_` : config.messages.error
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
};
