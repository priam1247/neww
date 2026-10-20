// src/bot/wa.js — WhatsApp transport via Baileys (optional dependency, lazy
// import so the engine still boots without it). Merged from Zafar-bot-main:
//   • "ZaFarBot!<gzip+b64>" session-string bootstrap (SESSION_ID)
//   • pairing-code login (PAIR_NUMBER) alongside the QR flow
//   • single-flight restarts (a dying socket can never spawn two connections)
//   • message hygiene: container unwrapping (viewOnce/ephemeral/edited),
//     dedup, 5-minute age gate, system-JID filter, suppressed socket logger
//   • SELF-BOT: messages typed on the linked phone (fromMe) are dispatched —
//     the bot's own API sends are recognised and skipped (no reply loops)
//   • session auto-repair: sustained "Bad MAC" decrypt failures on fresh
//     messages wipe ./session and re-pair; stale replays are skipped silently
//   • rich media transport (image/video/audio/sticker/doc + download)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import config from '../config.js';
import { handle } from './handler.js';
import { selfInstall, shouldAutoInstall, installedAdapterVersion } from './selfinstall.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import { classifyDecryptFail, healDecision, STUB_CIPHERTEXT } from './session-heal.js';

const wlog = log.child('wa');
const SESSION_DIR = process.env.SESSION_DIR || './session';

// ── console noise filter ────────────────────────────────────────────────────
// libsignal prints every undecryptable message STRAIGHT to the console
// ("Session error:Error: Bad MAC", "Failed to decrypt message with any known
// session...") — NOT through the Baileys logger, so the silent logger above
// cannot catch it. Filter exactly this known-harmless family; every other
// error passes through untouched.
const CONSOLE_NOISE = /Bad MAC|Failed to decrypt message|No session found to decrypt|Session error:|InvalidPreKeyId|MessageCounterError|Key used already/;
const rawConsoleError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    return '';
  }).join(' ');
  if (CONSOLE_NOISE.test(s)) return;   // decryption noise — counted in the pump instead
  rawConsoleError(...args);
};

// ── session health / auto-repair state (per process) ─────────────────────────
let sessionIgnored = false;   // true → SESSION_ID bootstrap is skipped this process
let resetDone = false;        // RESET_SESSION=1 has been processed once
let healAttempts = 0;         // auto-repairs used (cap 2 per process)
let healNoticeShown = false;  // manual-instructions notice printed once

function wipeSession() {
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    return true;
  } catch (e) {
    wlog.error('session wipe failed:', e.message);
    return false;
  }
}

// Baileys logs full signal-protocol dumps by default — silence the noise.
const silentLogger = ['error', 'warn', 'info', 'debug', 'trace'].reduce((acc, level) => {
  acc[level] = () => {};
  acc.child = () => silentLogger;
  return acc;
}, { level: 'silent', child: () => silentLogger });

/** SESSION_ID="ZaFarBot!<gzip+b64>" → session/creds.json (bootstrap only:
 *  never overwrite credentials already persisted by Baileys reconnects). */
function bootstrapSession() {
  if (sessionIgnored || !config.sessionId || !config.sessionId.startsWith('ZaFarBot!')) return;
  try {
    const [, b64] = config.sessionId.split('!');
    const clean = String(b64 || '').replace(/\.\.\./g, '');
    const creds = zlib.gunzipSync(Buffer.from(clean, 'base64'));
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const target = path.join(SESSION_DIR, 'creds.json');
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, creds, 'utf8');
      wlog.info('🔑 session restored from ZaFarBot session string');
    }
  } catch (e) {
    wlog.warn('session string processing failed:', e.message);
  }
}

// Unwrap WhatsApp containers (ephemeral, view once, edited, …) — they nest.
const CONTAINER_KEYS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
  'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
  'editedMessage', 'deviceSentMessage',
];

function unwrapContent(message) {
  let m = message;
  for (let i = 0; i < 5; i++) {
    const key = CONTAINER_KEYS.find(k => m?.[k]?.message);
    if (!key) break;
    m = m[key].message;
  }
  return m || null;
}

const isSystemJid = (jid) => !jid
  || jid.includes('@broadcast')
  || jid.includes('status.broadcast')
  || jid.includes('@newsletter');

// ── restart bookkeeping: every restart path goes through scheduleRestart ────
let currentSock = null;
let restartScheduled = false;

function scheduleRestart(startFn, delayMs = 3000) {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(() => {
    restartScheduled = false;
    startFn().catch(err => wlog.error('restart failed:', err.message));
  }, delayMs);
}

// ── degraded mode: a missing adapter must never kill the process ────────────
// The engine stays online; the adapter import is retried every 2 minutes so
// that an admin fixing deps (npm install / FORCE_INSTALL) self-heals without
// a restart. Only the FIRST failure prints the full instructions.
const ADAPTER_RETRY_MS = 2 * 60_000;
let degradedNoticeShown = false;

async function importAdapter() {
  const baileys = await import('@whiskeysockets/baileys');
  const qrTerminal = (await import('qrcode-terminal')).default;
  return { baileys, qrTerminal };
}

function logDegraded(reason) {
  if (degradedNoticeShown) return;
  degradedNoticeShown = true;
  wlog.error(`WhatsApp adapter unavailable (${reason}) — DEGRADED MODE.`);
  wlog.error('   the engine stays online; retrying the adapter every 2 minutes.');
  wlog.error('Fix: npm install   (or: npm i @whiskeysockets/baileys qrcode-terminal)');
  wlog.error('Pterodactyl: set FORCE_INSTALL=1 once, or point the startup command at: bash start.sh');
  wlog.error('(CLI mode still works: node cli.js "movie inception 1080")');
}

function scheduleAdapterRetry() {
  const t = setTimeout(() => {
    startWhatsApp().catch(e => wlog.error('adapter retry failed:', e.message));
  }, ADAPTER_RETRY_MS);
  t.ref?.();   // ref'd timer = the process stays alive in degraded mode
}

async function ensureAdapter() {
  try {
    return await importAdapter();                       // fast path
  } catch {
    // Panel deploys (Pterodactyl) skip npm install when node_modules already
    // exists, and npm silently skips optional deps that fail to install —
    // heal instead of dying: one bounded npm install, then retry the import.
    if (!shouldAutoInstall()) {
      logDegraded('auto-install disabled (OFFLINE=1 or WA_AUTOSTALL=0)');
      return null;
    }
    wlog.warn('WhatsApp adapter missing — self-installing once (npm, up to 5 min)…');
    const res = await selfInstall();
    if (!res.ok) {
      logDegraded(`self-install failed after ${Math.round(res.ms / 1000)}s — ${res.error || `npm exit ${res.code}`}`);
      return null;
    }
    try {
      const mods = await importAdapter();
      wlog.info(`✅ WhatsApp adapter self-installed in ${(res.ms / 1000).toFixed(1)}s — continuing boot`);
      return mods;
    } catch (e) {
      logDegraded(`still missing after install: ${e.message}`);
      return null;
    }
  }
}

export async function startWhatsApp() {
  const mods = await ensureAdapter();
  if (!mods) {
    scheduleAdapterRetry();
    return null;                       // degraded: process stays alive
  }
  const { baileys, qrTerminal } = mods;
  const adapterVer = installedAdapterVersion();
  if (adapterVer) wlog.info(`   adapter: @whiskeysockets/baileys ${adapterVer}`);

  const {
    default: makeWASocket, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, downloadMediaMessage,
  } = baileys;

  // RESET_SESSION=1 → start with a clean slate: wipe ./session and ignore any
  // SESSION_ID string for this boot so a fresh pairing code is requested.
  if (!resetDone && /^(1|true|yes|on)$/i.test(String(process.env.RESET_SESSION || ''))) {
    resetDone = true;
    sessionIgnored = true;
    wipeSession();
    wlog.warn('RESET_SESSION=1 → ./session wiped — a fresh pairing code will be printed');
    wlog.warn('(remove the RESET_SESSION variable again after the bot is paired)');
  }

  bootstrapSession();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  // a failed version lookup must never stop the bot from starting
  const sock = makeWASocket({
    version,
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
    // Ubuntu/Chrome signature — most reliable for pairing-code linking
    browser: ['Ubuntu', 'Chrome', '131.0.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    downloadHistory: false,
    getMessage: async () => undefined,
  });

  // never leave an old socket alive next to a new one (duplicate replies)
  if (currentSock) {
    const old = currentSock;
    currentSock = null;
    old.__superseded = true;
    try { await old.end(new Error('reconnecting')); } catch { /* already closed */ }
  }
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  // ── pairing code (alternative to scanning a QR) ────────────────────────────
  if (!state.creds.registered && config.pairNumber) {
    setTimeout(async () => {
      try {
        if (state.creds.registered) return;
        const code = await sock.requestPairingCode(config.pairNumber);
        wlog.info(`\n🔗 Pairing code: ${code}`);
        wlog.info('On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead" → enter this code.');
      } catch (e) {
        wlog.error('pairing code failed:', e.message);
        wlog.error('(if the number is wrong, set PAIR_NUMBER=0 to fall back to the QR flow)');
      }
    }, 3000);
  }

  // ── message dedup + age gate ───────────────────────────────────────────────
  const processedMessages = new Set();
  const selfSent = new Set();     // message ids the bot itself sent via the API
  const dedupTimer = setInterval(() => { processedMessages.clear(); selfSent.clear(); }, 5 * 60_000);
  dedupTimer.unref?.();

  // ── session-health telemetry (Bad MAC detection → auto-repair) ────────────
  let connectTs = Date.now();     // when this socket's link came up
  let freshDecryptFails = 0;      // failures on messages received AFTER the link
  let staleDecryptFails = 0;      // undecryptable replays queued BEFORE the link
  let decodedOk = 0;              // messages successfully decoded on this socket

  // ── media-aware transport ──────────────────────────────────────────────────
  const statusCache = new Map();   // jid -> status message key

  const quotedOf = (msg) => msg && Object.keys(msg).length ? { quoted: msg } : {};

  // every message the bot itself sends echoes back as a fromMe upsert —
  // remember its id so the self-bot never answers its own replies.
  const rawSend = sock.sendMessage.bind(sock);
  const trackSend = async (jid, content, opts) => {
    const res = await rawSend(jid, content, opts);
    if (res?.key?.id) selfSent.add(res.key.id);
    return res;
  };

  const asSource = (media) =>
    Buffer.isBuffer(media) ? media : (typeof media === 'string' ? { url: media } : media);

  const transport = {
    sock,   // exposed for commands that need raw Baileys (ping edit, broadcast)

    async say(jid, text, msg) {
      const sent = await trackSend(jid, { text }, quotedOf(msg));
      statusCache.set(jid, sent?.key);
      return sent;
    },

    async edit(jid, text) {
      const key = statusCache.get(jid);
      if (!key) return transport.say(jid, text);
      const sent = await trackSend(jid, { text, edit: key }).catch(() => null);
      if (!sent) return transport.say(jid, text);
      return sent;
    },

    /** throttled send-then-edit status card (progress, cleanup-safe) */
    statusCard(jid, initialText, msg) {
      let key = null, lastEdit = 0, lastText = initialText, disabled = false;
      trackSend(jid, { text: initialText }, quotedOf(msg))
        .then((sent) => { key = sent?.key || null; })
        .catch(() => { disabled = true; });
      return {
        async update(text, { force = false } = {}) {
          if (disabled || !key || text === lastText) return;
          const now = Date.now();
          if (!force && now - lastEdit < 4000) return;
          lastEdit = now; lastText = text;
          try { await trackSend(jid, { text, edit: key }); }
          catch { disabled = true; }
        },
        async final(text) {
          if (disabled || !key) {
            try { await trackSend(jid, { text }, quotedOf(msg)); } catch { /* ignore */ }
            return;
          }
          try { await trackSend(jid, { text, edit: key }); }
          catch { try { await trackSend(jid, { text }, quotedOf(msg)); } catch { /* ignore */ } }
        },
      };
    },

    async sendDoc(jid, filePath, caption, opts = {}) {
      const sent = await trackSend(jid, {
        document: asSource(filePath),
        mimetype: opts.mimetype || 'application/octet-stream',
        fileName: opts.fileName || path.basename(String(filePath)),
        caption,
      }, quotedOf(opts.msg));
      return sent;
    },

    async sendImage(jid, media, caption, opts = {}) {
      return trackSend(jid, { image: asSource(media), caption, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) }, quotedOf(opts.msg));
    },

    async sendVideo(jid, media, caption, opts = {}) {
      return trackSend(jid, { video: asSource(media), caption, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) }, quotedOf(opts.msg));
    },

    async sendAudio(jid, media, opts = {}) {
      return trackSend(jid, {
        audio: asSource(media),
        mimetype: opts.mimetype || 'audio/mpeg',
        ptt: Boolean(opts.ptt),
        ...(opts.fileName ? { fileName: opts.fileName } : {}),
        ...(opts.caption ? { caption: opts.caption } : {}),
      }, quotedOf(opts.msg));
    },

    async sendSticker(jid, buffer) {
      return trackSend(jid, { sticker: buffer }, {});
    },

    async react(jid, emoji, msgKey) {
      return trackSend(jid, { react: { text: emoji, key: msgKey } });
    },

    /** download media from any message (sticker/viewonce/cookies-file commands) */
    async downloadMedia(msg) {
      if (!msg?.message) return null;
      try {
        return await downloadMediaMessage(msg, 'buffer', {}, {
          logger: undefined,
          reuploadRequest: sock.updateMediaMessage,
        });
      } catch (e) {
        wlog.warn('media download failed:', e.message);
        return null;
      }
    },
  };

  // ── connection lifecycle ───────────────────────────────────────────────────
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    // only the live socket may drive reconnects: a superseded socket must not
    // schedule a restart that would kill the new connection (restart loop)
    if (sock.__superseded || (currentSock && currentSock !== sock)) return;

    if (qr && !config.pairNumber) qrTerminal.generate(qr, { small: true });

    if (connection === 'open') {
      connectTs = Date.now();
      freshDecryptFails = 0;
      staleDecryptFails = 0;
      decodedOk = 0;
      wlog.info('✅ WhatsApp connected');
      wlog.info(`   bot number: ${sock.user?.id?.split(':')?.[0] || '?'}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const rejoin = code !== DisconnectReason.loggedOut;
      wlog.warn(`connection closed (${code}) — ${rejoin ? 'reconnecting…' : 'logged out, delete ./session to re-pair'}`);
      if (rejoin) scheduleRestart(startWhatsApp);
      else process.exit(1);
    }
  });

  // ── message pump ───────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;   // skip history sync ("append")
    for (const msg of messages) {
      try {
        const key = msg?.key;
        if (!key?.id) continue;

        // ── undecryptable messages (Bad MAC family) ────────────────────────────
        // Baileys turns decryption failures into "ciphertext stub" upserts:
        // no .message, messageStubType CIPHERTEXT, the reason in stub params.
        //  • stale (queued before the link): can never decrypt — skip quietly
        //  • fresh (arrived after the link): if a sustained burst fails with
        //    zero decodes, the stored session keys are corrupted → wipe
        //    ./session and re-pair automatically (capped at 2 attempts).
        if (!msg.message && (msg.messageStubType === STUB_CIPHERTEXT
          || /decrypt|session|mac/i.test(String(msg.messageStubParameters?.[0] || '')))) {
          const kind = classifyDecryptFail(msg, connectTs);
          if (kind === 'stale') {
            staleDecryptFails++;
            if (staleDecryptFails === 1 || staleDecryptFails % 50 === 0) {
              wlog.info(`⏭  ${staleDecryptFails} old queued message(s) skipped — encrypted for a previous session, harmless`);
            }
          } else {
            freshDecryptFails++;
            if (freshDecryptFails % 5 === 0) {
              wlog.warn(`${freshDecryptFails} fresh message(s) failed to decrypt — waiting to confirm…`);
            }
          }
          const d = healDecision({ freshFails: freshDecryptFails, decoded: decodedOk, attempts: healAttempts });
          if (d.exhausted) {
            if (!healNoticeShown) {
              healNoticeShown = true;
              wlog.error('🧠 session keys are corrupted and auto-repair is exhausted (2/2).');
              wlog.error('   Panel fix: File Manager → delete the "session" folder → restart → pair once.');
              wlog.error('   Or set RESET_SESSION=1 once, restart, and remove it again after pairing.');
            }
          } else if (d.wipe && Date.now() - connectTs > 20_000) {
            healAttempts++;
            wlog.error(`🧠 ${freshDecryptFails} fresh messages undecryptable, 0 decoded — session keys corrupted.`);
            wlog.error(`   wiping ./session and re-pairing automatically (repair ${healAttempts}/2)…`);
            wipeSession();
            scheduleRestart(startWhatsApp, 2000);
          }
          continue;
        }

        if (!msg.message) continue;

        // SELF-BOT: messages typed on the linked phone arrive as fromMe —
        // they ARE dispatched. Only the bot's own API sends (tracked in
        // selfSent) are skipped, so the bot never replies to itself.
        if (key.fromMe && selfSent.has(key.id)) continue;

        const jid = key.remoteJid;
        if (isSystemJid(jid)) continue;

        // dedup
        if (processedMessages.has(key.id)) continue;
        processedMessages.add(key.id);

        // age gate: stale history replays must not trigger commands
        const age = msg.messageTimestamp ? Date.now() - (msg.messageTimestamp * 1000) : 0;
        if (age > config.messageAgeLimitMs) continue;

        const content = unwrapContent(msg.message);
        if (!content) continue;
        const protocolOnly = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
        if (Object.keys(content).filter(k => !protocolOnly.includes(k)).length === 0) continue;

        const text = content.conversation
          || content.extendedTextMessage?.text
          || content.imageMessage?.caption
          || content.videoMessage?.caption
          || content.documentMessage?.caption
          || content.buttonsResponseMessage?.selectedButtonId
          || content.listResponseMessage?.singleSelectReply?.selectedRowId
          || '';
        if (!String(text).trim()) continue;

        decodedOk++;
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        const handled = await handle(transport, jid, String(text).trim(), { ...msg, message: content });
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        if (handled) metrics.bump('wa.message');
      } catch (e) {
        wlog.error('message pump error:', e.message);
      }
    }
  });

  return sock;
}
