/**
 * Message Handler - Processes incoming messages and executes commands
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const database = require('./database');
const selections = require('./utils/selections');
const { loadCommands } = require('./utils/commandLoader');
const { jidVariants, isSystemJid } = require('./utils/jid');
const { readWL, findAllowedUserIndex } = require('./utils/accessControl');
const { safeErrorMessage } = require('./utils/userErrors');
const telemetry = require('./utils/telemetry');
const jobs = require('./utils/persistentJobs');
const router = require('./utils/providerRouter');
const rcloneStore = require('./utils/rcloneStore');
const mediaTransfer = require('./utils/mediaTransfer');
const { getTempDir, deleteTempFile } = require('./utils/tempManager');

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
  reply: (text) => sock.sendMessage(from, { text }, selections.quoteOpts(msg)),
  status: async (initialText) => {
    const sent = await sock.sendMessage(from, { text: initialText }, selections.quoteOpts(msg));
    return {
      update: async (finalText) => {
        try {
          return await sock.sendMessage(from, { text: finalText, edit: sent.key });
        } catch (e) {
          return sock.sendMessage(from, { text: finalText }, selections.quoteOpts(msg));
        }
      },
    };
  },
});

// Extract the stanzaId of any message quoted by `content`, if present.
const getQuotedMessageId = (content) =>
  content?.extendedTextMessage?.contextInfo?.stanzaId ||
  content?.interactiveResponseMessage?.contextInfo?.stanzaId ||
  content?.buttonsResponseMessage?.contextInfo?.stanzaId ||
  content?.listResponseMessage?.contextInfo?.stanzaId ||
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
  telemetry.recordCommand(command.name || invoked);
  try {
    await command.execute(
      sock,
      msg,
      args || [],
      buildExtra(sock, msg, { from, sender, senderIds, commandName: invoked }),
    );
  } catch (err) {
    telemetry.recordFailure('command');
    throw err;
  }
  return true;
}

// Tap-selector & "reply with a number" answers are resolved here.
async function handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId = null }) {
  const opts = { quotedMessageId, rawText: body };
  const open = selections.peek(from, senderIds, opts);
  if (!open) return false;

  if (selections.isCancel(body)) {
    selections.clear(from, senderIds, opts);
    await sock.sendMessage(from, { text: '👍 Cancelled.' }, selections.quoteOpts(msg));
    return true;
  }

  const picked = selections.match(from, senderIds, body, opts);
  if (picked) {
    try {
      await picked.entry.run(sock, msg, buildExtra(sock, msg, { from, sender, senderIds }), picked.item);
    } catch (e) {
      telemetry.recordFailure('selection');
      console.error('Error running selection:', e.message);
      try {
        await sock.sendMessage(
          from,
          { text: safeErrorMessage(e, { isOwner: isOwner(senderIds) }) },
          selections.quoteOpts(msg),
        );
      } catch { /* ignore */ }
    }
    return true;
  }

  if (selections.isOutOfRange(from, senderIds, body, opts)) {
    await sock.sendMessage(from, {
      text: `❌ Reply *1–${open.items.length}* or *cancel*.`,
    }, selections.quoteOpts(msg));
    return true;
  }

  return false;
}

// ── Background link jobs ─────────────────────────────────────────────────────
// A bare link from an allowed user in a direct chat is queued to the persistent
// worker pool instead of blocking the message handler. Small results come back
// as normal WhatsApp media, large ones as an rclone share link.
const URL_ONLY = /^https?:\/\/\S+$/i;
let activeSock = null;
let jobsStarted = false;

const urlJobsEnabled = () => String(process.env.URL_JOBS ?? '1') !== '0';

const shortError = (text, max = 160) => {
  const line = String(text || 'failed').split('\n').map(s => s.trim()).filter(Boolean).pop() || 'failed';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const isOwnerJid = (jid) => isOwner([String(jid || '')]);

async function say(chatId, text, quoted) {
  if (!activeSock || !chatId) return;
  try {
    await activeSock.sendMessage(chatId, { text }, quoted ? { quoted } : {});
  } catch (e) {
    console.error('jobs: reply failed:', e.message);
  }
}

// Only files this bot produced (MEDIA_DIR or temp/) are ever removed here.
const ownedByBot = (file) => {
  const target = path.resolve(String(file || ''));
  return [router.mediaDir(), getTempDir()]
    .map((dir) => path.resolve(dir))
    .some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`));
};

function discardJob(job) {
  for (const file of [job.path, ...(job.subs || [])]) {
    if (!file) continue;
    if (ownedByBot(file)) {
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    } else {
      deleteTempFile(file);
    }
  }
}

/** Send a finished download inline (media picks) or as a document. */
async function sendJobInline(sock, chatId, job, size) {
  const sniff = mediaTransfer.sniffFile(job.path);
  const name = mediaTransfer.safeName(job.title || path.basename(job.path), 'media');
  const caption = `📥 *${job.title || name}*${job.quality ? `\n🎞️ ${job.quality}` : ''}\n📦 ${mediaTransfer.fmtMB(size)}`;

  if (sniff.kind === 'video') {
    const ready = await mediaTransfer.ensureWhatsAppMp4(job.path, path.join(getTempDir(), `${path.basename(job.path)}.wa.mp4`));
    try {
      const finalSize = fs.statSync(ready).size;
      const payload = finalSize > 50 * 1024 * 1024
        ? { document: { url: ready }, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption }
        : { video: { url: ready }, mimetype: 'video/mp4', caption };
      await sock.sendMessage(chatId, payload);
    } finally {
      if (ready !== job.path) deleteTempFile(ready);
    }
    return;
  }

  if (sniff.kind === 'audio') {
    await sock.sendMessage(chatId, {
      audio: { url: job.path }, mimetype: sniff.mime, fileName: `${name}.${sniff.ext}`, ptt: false,
    });
    return;
  }

  if (sniff.kind === 'image') {
    await sock.sendMessage(chatId, { image: { url: job.path }, caption });
    return;
  }

  await sock.sendMessage(chatId, {
    document: { url: job.path }, mimetype: sniff.mime, fileName: `${name}.${sniff.ext}`, caption,
  });
}

/** Deliver a finished job, then delete its temp files. */
async function deliverJob(job) {
  const chatId = job.req?.chatId;
  const file = job.path;

  try {
    if (!chatId || !file || !fs.existsSync(file)) return;
    const size = Number(job.size) || fs.statSync(file).size;

    if (size > rcloneStore.inlineLimit()) {
      const link = await rcloneStore.put(file, size);
      await say(chatId, `📦 *${job.title || path.basename(file)}* — ${mediaTransfer.fmtMB(size)}\n${link}`);
      return;
    }

    if (!activeSock) return;
    await sendJobInline(activeSock, chatId, job, size);
  } catch (e) {
    const isOwner = Boolean(job.req?.sender) && isOwnerJid(job.req.sender);
    await say(chatId, `❌ ${safeErrorMessage(e, { isOwner })}`);
  } finally {
    discardJob(job);
  }
}

/** Boot the worker pool on first use so imports stay side-effect free. */
function ensureJobs() {
  if (jobsStarted) return;
  jobsStarted = true;
  jobs.on('done', (job) => {
    deliverJob(job).catch((e) => console.error('jobs: delivery failed:', e.message));
  });
  jobs.on('fail', (job) => {
    say(job.req?.chatId, `❌ ${shortError(job.error)}`).catch(() => {});
  });
  jobs.start();
  console.log('jobs: worker pool online');
}

/**
 * Queue a bare link. Returns true when the message was handled here.
 * Groups are left alone so one link cannot start downloads for everybody.
 */
async function queueLinkJob(sock, msg, body, { from, sender }) {
  if (!urlJobsEnabled()) return false;
  if (!URL_ONLY.test(body)) return false;
  if (!String(from || '').endsWith('@s.whatsapp.net')) return false;

  let target;
  try {
    target = router.route(body);
  } catch {
    await sock.sendMessage(from, { text: '❌ Not a downloadable link.' }, { quoted: msg });
    return true;
  }

  if (target.blocked) {
    await sock.sendMessage(from, { text: `❌ ${target.reason}` }, { quoted: msg });
    return true;
  }

  ensureJobs();
  try {
    const id = jobs.enqueue({ provider: target.provider, req: { url: body, chatId: from, sender } });
    await sock.sendMessage(from, { text: `⚙️ Queued #${id}` }, { quoted: msg });
  } catch (e) {
    if (e.code === 'QUEUE_FULL') await sock.sendMessage(from, { text: '⚠️ Queue is full, try again later.' }, { quoted: msg });
    else if (e.code === 'NOT_ENOUGH_DISK') await sock.sendMessage(from, { text: '⚠️ Not enough disk space right now.' }, { quoted: msg });
    else throw e;
  }
  return true;
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

    // The worker pool delivers finished jobs through this socket.
    activeSock = sock;

    // ── Poll votes (`pollUpdateMessage`) ──────────────────────────────────
    if (content.pollUpdateMessage) {
      const voteHit = selections.resolvePollVote(sock, msg);
      if (voteHit) {
        const pollKey = content.pollUpdateMessage.pollCreationMessageKey || msg.key;
        const quoteMsg = voteHit.originMsg || {
          key: { ...pollKey, remoteJid: voteHit.chatId },
          message: { conversation: voteHit.entry?.label || 'Selected' },
        };
        try {
          await voteHit.entry.run(
            sock,
            quoteMsg,
            buildExtra(sock, quoteMsg, { from: voteHit.chatId, sender, senderIds }),
            voteHit.item,
          );
        } catch (e) {
          telemetry.recordFailure('selection');
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
    } else if (content.interactiveResponseMessage) {
      body = selections.extractInteractiveSelection(content);
    } else if (content.buttonsResponseMessage) {
      body = content.buttonsResponseMessage.selectedButtonId || '';
    } else if (content.listResponseMessage) {
      body = content.listResponseMessage.singleSelectReply?.selectedRowId || '';
    }
    body = (body || '').trim();

    const quotedMessageId = getQuotedMessageId(content);

    // "Reply with a number" for a command that offered a list
    if (await handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId })) return;

    // A bare link in a direct chat becomes a background job; ordinary text is
    // still ignored and every command still needs its prefix.
    if (!body.startsWith(config.prefix)) {
      await queueLinkJob(sock, msg, body, { from, sender });
      return;
    }

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
