/**
 * WhatsApp MD Bot - Main Entry Point
 */

// A fresh install (or a panel reinstall) has no node_modules yet. Say that in
// one line instead of letting the first require() throw a 40-line stack.
(function checkDependencies() {
  try {
    require.resolve('@whiskeysockets/baileys');
  } catch {
    console.error('❌ Dependencies are missing — run `npm install` in this folder.');
    console.error('   Make sure the panel\'s Startup Command runs it, e.g. `npm install && node index.js`.');
    process.exit(1);
  }
})();

// Production by default: skips the pino-pretty worker thread + dev overhead.
// Override with NODE_ENV=development when debugging locally.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { formatArgs, redactArg } = require('./utils/safeLog');
const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
const { startDiskGuard } = require('./utils/diskGuard');
initializeTempSystem();
startCleanup();
startDiskGuard();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey'
];

console.log = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleLog.apply(console, args.map(redactArg));
  }
};

console.error = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleError.apply(console, args.map(redactArg));
  }
};

console.warn = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleWarn.apply(console, args.map(redactArg));
  }
};

// Now safe to load libraries
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const handler = require('./handler');
const { createReconnector } = require('./utils/reconnect');
const { isSystemJid } = require('./utils/jid');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Optimized message deduplication (Set-based, no timestamps needed)
const processedMessages = new Set();

// Aggressive cleanup - clear every 5 minutes
setInterval(() => {
  processedMessages.clear();
}, 5 * 60 * 1000); // Every 5 minutes

// Custom Pino logger with suppression for Baileys noise
const createSuppressedLogger = (level = 'silent') => {
  const forbiddenPatterns = [
    'closing session',
    'closing open session',
    'sessionentry',
    'prekey bundle',
    'pendingprekey',
    '_chains',
    'registrationid',
    'currentratchet',
    'chainkey',
    'ratchet',
    'signal protocol',
    'ephemeralkeypair',
    'indexinfo',
    'basekey',
    'sessionentry',
    'ratchetkey'
  ];

  let logger;
  try {
    logger = pino({
      level,
      // Fallback transport without pino-pretty (in case not installed)
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname'
        }
      },
      customLevels: {
        trace: 0,
        debug: 1,
        info: 2,
        warn: 3,
        error: 4,
        fatal: 5
      },
      // Redact sensitive fields
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch (err) {
    // Fallback to basic pino without transport
    logger = pino({ level });
  }

  // Wrap log methods to filter
  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = formatArgs(args);
    if (!forbiddenPatterns.some(pattern => msg.includes(pattern))) {
      originalInfo(...args);
    }
  };
  logger.debug = () => { }; // Fully disable debug
  logger.trace = () => { }; // Fully disable trace
  return logger;
};

// ─── Restart bookkeeping ──────────────────────────────────────────────────────
// Every restart path goes through scheduleRestart(): a socket that dies must
// never end up with two live connections (watchdog + close handler used to race).
let currentSock = null;

// ── pairing (dashboard-driven) ───────────────────────────────────────────────
// A pairing code can only exist while the bot has no registered session, so a
// request from the dashboard (POST /admin/api/pair) wipes the unregistered
// session folder and lets WhatsApp issue a fresh code. The code is captured
// here because the socket emits it asynchronously.
const pairing = { number: null, code: null, at: 0, error: null, waiters: [] };

function notePairingCode(number, code) {
  pairing.number = String(number || '');
  pairing.code = String(code || '');
  pairing.at = Date.now();
  pairing.error = null;
  for (const w of pairing.waiters.splice(0)) w.resolve({ code: pairing.code, expiresInSeconds: 60 });
}

function notePairingError(err) {
  pairing.error = err?.message || String(err);
  for (const w of pairing.waiters.splice(0)) w.reject(new Error(pairing.error));
}

/** Wait for the socket to hand over a code (or fail) — max 25s. */
function waitForPairingCode(timeoutMs = 25_000) {
  if (pairing.code && Date.now() - pairing.at < 60_000) {
    return Promise.resolve({ code: pairing.code, expiresInSeconds: 60 });
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject: (e) => reject(Object.assign(e, { statusCode: 502 })),
    };
    pairing.waiters.push(waiter);
    setTimeout(() => {
      const i = pairing.waiters.indexOf(waiter);
      if (i !== -1) pairing.waiters.splice(i, 1);
      reject(Object.assign(
        new Error(pairing.error || 'WhatsApp did not issue a pairing code — check the bot logs.'),
        { statusCode: 504 },
      ));
    }, timeoutMs).unref?.();
  });
}

/** Bot number, when connected. */
const connectedNumber = () => {
  try {
    const id = currentSock?.user?.id;
    return id ? String(id).split(':')[0].split('@')[0] : null;
  } catch { return null; }
};

const reconnector = createReconnector({
  baseMs: 3000,
  maxMs: 60_000,
  start: () => startBot(),
  onError: (err, attempt, nextDelayMs) => {
    console.error(
      `⚠️ Reconnect attempt #${attempt} failed (${err?.message || err}) — retrying in ${Math.round(nextDelayMs / 1000)}s...`
    );
  },
});

function scheduleRestart(delayMs) {
  reconnector.schedule(delayMs);
}

// Main connection function
async function startBot() {
  // Never leave an old socket alive next to a new one (duplicate replies).
  if (currentSock) {
    const old = currentSock;
    currentSock = null;
    old.__superseded = true; // its 'close' event must not schedule another restart
    try { await old.end(new Error('reconnecting')); } catch (_) { /* already closed */ }
  }

  const sessionFolder = `./${config.sessionName}`;
  const sessionFile = path.join(sessionFolder, 'creds.json');

  // Check if sessionID is provided and process ZaFarBot! format session
  if (config.sessionID && config.sessionID.startsWith('ZaFarBot!')) {
    try {
      const [header, b64data] = config.sessionID.split('!');

      if (header !== 'ZaFarBot' || !b64data) {
        throw new Error("❌ Invalid session format. Expected 'ZaFarBot!.....'");
      }

      const cleanB64 = b64data.replace('...', '');
      const compressedData = Buffer.from(cleanB64, 'base64');
      const decompressedData = zlib.gunzipSync(compressedData);

      // Ensure session folder exists
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      // SESSION_ID is a bootstrap credential. Never overwrite credentials
      // already persisted by Baileys: reconnects must keep the latest creds.
      if (!fs.existsSync(sessionFile)) {
        fs.writeFileSync(sessionFile, decompressedData, 'utf8');
        console.log('📡 Session : 🔑 Retrieved from ZaFarBot Session');
      }

    } catch (e) {
      console.error('📡 Session : ❌ Error processing ZaFarBot session:', e.message);
      // Continue with normal QR flow if session processing fails
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  // A failed version lookup must never stop the bot from starting.
  let version;
  try {
    ({ version } = await fetchLatestWaWebVersion());
  } catch (e) {
    console.warn('⚠️ Could not fetch the latest WhatsApp Web version, using the pinned one:', e.message);
    version = [2, 3000, 1033141466]; // last known-good WA Web version
  }

  // Use suppressed logger for socket
  const suppressedLogger = createSuppressedLogger('silent');

  const sock = makeWASocket({
    version, // explicit WA Web version negotiated with the server
    logger: suppressedLogger,
    printQRInTerminal: false,
    // Ubuntu/Chrome signature — most reliable for pairing-code linking
    browser: Browsers.ubuntu('Chrome'),
    auth: state,
    // Memory optimization: prevent loading old messages into RAM
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined
  });

  // ─── Pairing code (alternative to scanning a QR) ─────────────────────────
  if (!state.creds.registered && config.pairNumber) {
    setTimeout(async () => {
      try {
        if (state.creds.registered) return; // already linked (e.g. via a previous attempt)
        const code = await sock.requestPairingCode(config.pairNumber.replace(/[^0-9]/g, ''));
        console.log(`\n🔗 Pairing code: ${code}`);
        console.log('On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead" → enter this code.\n');
        notePairingCode(config.pairNumber, code);
      } catch (e) {
        console.error('Failed to generate pairing code:', e.message);
        notePairingError(e);
      }
    }, 3000);
  }

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Only the live socket may drive reconnects: a socket that is being
    // replaced must not schedule a restart that would kill the new connection
    // (that would loop: replace → old close → restart → replace → …).
    if (sock.__superseded || (currentSock && currentSock !== sock)) return;

    if (qr && !config.pairNumber) {
      console.log('\n\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      // Suppress verbose error output for common stream errors (515, etc.)
      if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
        console.log(`⚠️ Connection closed (${statusCode}). Reconnecting...`);
      } else {
        console.log('Connection closed due to:', errorMessage, '\nReconnecting:', shouldReconnect);
      }

      if (shouldReconnect) {
        const delayMs = reconnector.schedule();
        if (typeof delayMs === 'number') {
          console.log(`🔄 Reconnect scheduled in ${Math.round(delayMs / 1000)}s (attempt #${reconnector.attempts}).`);
        }
      } else {
        reconnector.cancel();
        if (currentSock === sock) currentSock = null;
        console.error(
          `❌ Logged out of WhatsApp. Session files in ./${config.sessionName} were NOT deleted — ` +
          `waiting for pairing from the web dashboard (or remove ./${config.sessionName} manually and restart).`
        );
      }
    } else if (connection === 'open') {
      reconnector.reset();
      console.log('\n✅ Bot connected successfully!');
      console.log(`📱 Bot Number: ${sock.user.id.split(':')[0]}`);
      console.log(`Bot Name: ${config.botName}`);
      console.log(`⚡ Prefix: ${config.prefix}`);
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
      console.log(`👑 Owner: ${ownerNames}\n`);
      console.log('Bot is ready to receive messages!\n');
    }
  });

  // Credentials update handler
  sock.ev.on('creds.update', saveCreds);

  // Messages handler - Process only new messages
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // Only process "notify" type (new messages), skip "append" (old messages from history)
    if (type !== 'notify') return;

    // Process messages in the array
    for (const msg of messages) {
      // Skip if message is invalid or missing key
      if (!msg.message || !msg.key?.id) continue;

      const from = msg.key.remoteJid;
      if (!from) {
        continue;
      }

      // System message filter - ignore broadcast/status/newsletter messages
      if (isSystemJid(from)) {
        continue; // Silently ignore system messages
      }

      // Deduplication: Skip if message has already been processed
      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      // Timestamp validation: Only process messages within last 5 minutes
      const MESSAGE_AGE_LIMIT = 5 * 60 * 1000; // 5 minutes in milliseconds
      let messageAge = 0;
      if (msg.messageTimestamp) {
        messageAge = Date.now() - (msg.messageTimestamp * 1000);
        if (messageAge > MESSAGE_AGE_LIMIT) {
          // Message is too old, skip processing
          continue;
        }
      }

      // Mark message as processed
      processedMessages.add(msgId);

      // Process command IMMEDIATELY (don't block on other operations)
      handler.handleMessage(sock, msg).catch(err => {
        if (!err.message?.includes('rate-overlimit') &&
          !err.message?.includes('not-authorized')) {
          console.error('Error handling message:', err.message);
        }
      });
    }
  });

  // Handle errors - suppress common stream errors
  sock.ev.on('error', (error) => {
    const statusCode = error?.output?.statusCode;
    // Suppress verbose output for common stream errors
    if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
      // These are usually temporary connection issues, handled by reconnection
      return;
    }
    console.error('Socket error:', error.message || error);
  });

  currentSock = sock;
  return sock;
}

// Start the bot — one aligned block instead of loose lines
const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
require('./utils/logger').banner([
  'ZaFar Bot',
  `name     ${config.botName}`,
  `prefix   ${config.prefix}`,
  `owner    ${ownerNames}`,
  `node     ${process.version}`,
]);

// yt-dlp looks after itself: install/repair at boot, verify every 30 minutes,
// and re-download the binary when a download reports it as missing or broken.
(() => {
  const YT = require('./utils/youtubedl');
  YT.scheduleAutoUpdate();
  YT.healthCheck().then((cmd) => {
    console.log(cmd ? `🎬 yt-dlp  ${YT.version() || 'ready'}` : '🎬 yt-dlp  ❌ not available (will retry while running)');
  }).catch(() => {});
  YT.startWatchdog({ everyMinutes: 30 });
})();

// ── Dashboard API + whitelist sync ───────────────────────────────────────────
// The web dashboard (Cloudflare app) links to this bot with a URL + token and
// then drives it over /admin/api/*. Without ADMIN_DASHBOARD_TOKEN nothing here
// starts, so a plain WhatsApp-only deployment is byte-for-byte the same.
(function startDashboardBridge() {
  const admin = config.admin || {};
  const { startAdminApi } = require('./utils/adminApi');
  const { startAllowlistSync } = require('./utils/allowlistSync');

  if (!admin.token) {
    console.log('🌐 Dashboard API: off (ADMIN_DASHBOARD_TOKEN not set)');
    return;
  }

  startAdminApi({
    port: admin.port,
    token: admin.token,
    allowedOrigins: admin.corsOrigins || [],
    hooks: {
      status: async () => {
        const number = connectedNumber();
        const { readWL } = require('./utils/accessControl');
        return {
          connected: Boolean(number),
          botNumber: number,
          botName: config.botName,
          paired: Boolean(config.pairNumber),
          members: readWL().users.filter((u) => u.enabled !== false).length,
          pendingPairing: Boolean(pairing.code && Date.now() - pairing.at < 60_000),
        };
      },

      requestPair: async (number) => {
        if (!/^\d{7,15}$/.test(number)) {
          throw Object.assign(new Error('WhatsApp numbers must be 7–15 digits, country code first.'), { statusCode: 400 });
        }
        const live = connectedNumber();
        if (live) {
          throw Object.assign(new Error(
            `This bot is already linked to +${live}. Log it out in WhatsApp → Linked devices before linking another number.`,
          ), { statusCode: 409 });
        }

        // fresh session: WhatsApp only issues a code for an unregistered socket
        const folder = `./${config.sessionName}`;
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* ignore */ }

        pairing.number = number;
        pairing.code = null;
        pairing.at = 0;
        pairing.error = null;
        config.pairNumber = number;
        reconnector.reset();

        await startBot();
        return waitForPairingCode();
      },
    },
  });

  startAllowlistSync();
  console.log(`🌐 Dashboard API: on (port ${admin.port}${admin.dashboardUrl ? `, sync ${admin.dashboardUrl}` : ''})`);
})();

startBot().catch(err => {
  console.error('⚠️ Initial bot connection failed:', err.message || err);
  scheduleRestart();
});
// Handle process termination
process.on('uncaughtException', (err) => {
  // Handle ENOSPC errors gracefully without crashing
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.error('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return; // Don't crash, just log and continue
  }
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  // Handle ENOSPC errors gracefully
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.warn('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return; // Don't crash, just log and continue
  }

  // Don't spam console with rate limit errors
  if (err.message && err.message.includes('rate-overlimit')) {
    console.warn('⚠️ Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});
// Export store for use in commands
module.exports = { store };
