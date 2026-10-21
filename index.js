/**
 * WhatsApp MD Bot - Main Entry Point
 */
// ── heap sizing ──────────────────────────────────────────────────────────────
// The panel starts us as a bare `node index.js`, so V8 picks a default old
// space of roughly half of RAM (~2 GB on a 4 GB box, ~2.2 GB on a 4.5 GB box)
// and the bot OOMs long before the machine is actually full.
// Re-exec ONCE with an explicit heap; the env guard prevents a loop.
// (Top-level `return` is legal in CommonJS: the parent then just waits for the
// child and mirrors its exit code, so the bot never runs twice.)
//
// The numbers live in utils/heapPlan.js: RAM − reserve, capped at 4200 MB,
// which budgets ~4160 MB of heap on a 4.5 GB plan.
const { computeHeapMB } = require('./utils/heapPlan');

function respawnWithBiggerHeap() {
  if (process.env.ZAFAR_HEAP_SIZED === '1') return false;

  const totalMB = Math.round(require('os').totalmem() / 1048576);
  const askedMB = Number(process.env.HEAP_MB) || Number(process.env.MEMORY_LIMIT_MB) || 0;
  const { heapMB: wantMB, capped } = computeHeapMB({ totalMB, askedMB });
  if (!Number.isFinite(wantMB) || wantMB < 512) return false;
  if (capped) {
    console.warn(`[BOOT] heap ${askedMB} MB is more than this ${totalMB} MB box can give — using ${wantMB} MB`);
  }
  if (process.execArgv.some(a => a.startsWith('--max-old-space-size'))) return false;

  let currentMB = 0;
  try { currentMB = require('v8').getHeapStatistics().heap_size_limit / 1048576; } catch { /* ignore */ }
  if (currentMB >= wantMB * 0.9) return false;

  const { spawn } = require('child_process');
  const args = ['--expose-gc', `--max-old-space-size=${wantMB}`, __filename, ...process.argv.slice(2)];
  console.log(`[BOOT] heap ${Math.round(currentMB)} MB → ${wantMB} MB (restarting once)`);

  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ZAFAR_HEAP_SIZED: '1' },
  });
  child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
  child.on('error', (e) => { console.error('[BOOT] could not resize heap:', e.message); process.exit(1); });
  return true;
}

if (respawnWithBiggerHeap()) return;

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer_cache_disabled';
// Production by default: skips the pino-pretty worker thread + dev overhead.
// Override with NODE_ENV=development when debugging locally.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { formatArgs } = require('./utils/safeLog');
const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
const { startMemoryWatchdog } = require('./utils/memoryWatchdog');
initializeTempSystem();
startCleanup();
// NOTE: startMemoryWatchdog() is called further down, after `store` exists,
// so it receives live references and can actually trim the store.
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
    originalConsoleLog.apply(console, args);
  }
};

console.error = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleError.apply(console, args);
  }
};

console.warn = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleWarn.apply(console, args);
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
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

// Remove Puppeteer cache (if some dependency downloaded Chromium into ~/.cache/puppeteer)
function cleanupPuppeteerCache() {
  try {
    const home = os.homedir();
    const cacheDir = path.join(home, '.cache', 'puppeteer');

    if (fs.existsSync(cacheDir)) {
      console.log('🧹 Removing Puppeteer cache at:', cacheDir);
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log('✅ Puppeteer cache removed');
    }
  } catch (err) {
    console.error('⚠️ Failed to cleanup Puppeteer cache:', err.message || err);
  }
}
// Optimized in-memory store with hard limits (Map-based for better memory management)
const store = {
  messages: new Map(), // Use Map instead of plain object
  maxPerChat: 20, // Limit to 20 messages per chat
  maxChats: 300, // Limit total chats (oldest chat evicted)

  bind: (ev) => {
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;

        const jid = msg.key.remoteJid;
        if (!store.messages.has(jid)) {
          store.messages.set(jid, new Map());
        }

        const chatMsgs = store.messages.get(jid);
        chatMsgs.set(msg.key.id, msg);

        // Aggressive cleanup per chat - keep only recent messages
        if (chatMsgs.size > store.maxPerChat) {
          // Remove oldest message (first entry in Map)
          const oldestKey = chatMsgs.keys().next().value;
          chatMsgs.delete(oldestKey);
        }
        // Cap total chats - evict oldest chat (Map preserves insertion order)
        if (store.messages.size > store.maxChats) {
          store.messages.delete(store.messages.keys().next().value);
        }
      }
    });
  },

  loadMessage: async (jid, id) => {
    return store.messages.get(jid)?.get(id) || null;
  }
};

// Start RAM watchdog with live references (see NOTE above)
startMemoryWatchdog(store);

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
let restartScheduled = false;

function scheduleRestart(delayMs = 3000) {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(() => {
    restartScheduled = false;
    startBot().catch(err => console.error('Error restarting bot:', err.message));
  }, delayMs);
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
    getMessage: async () => undefined // Don't load messages from store
  });

  // Bind store to socket
  store.bind(sock.ev);

  // ─── Pairing code (alternative to scanning a QR) ─────────────────────────
  if (!state.creds.registered && config.pairNumber) {
    setTimeout(async () => {
      try {
        if (state.creds.registered) return; // already linked (e.g. via a previous attempt)
        const code = await sock.requestPairingCode(config.pairNumber.replace(/[^0-9]/g, ''));
        console.log(`\n🔗 Pairing code: ${code}`);
        console.log('On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead" → enter this code.\n');
      } catch (e) {
        console.error('Failed to generate pairing code:', e.message);
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
        scheduleRestart(3000);
      } else {
        console.error(`❌ Logged out of WhatsApp. Delete ./${config.sessionName} and restart to link the bot again.`);
      }
    } else if (connection === 'open') {
      console.log('\n✅ Bot connected successfully!');
      console.log(`📱 Bot Number: ${sock.user.id.split(':')[0]}`);
      console.log(`Bot Name: ${config.botName}`);
      console.log(`⚡ Prefix: ${config.prefix}`);
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
      console.log(`👑 Owner: ${ownerNames}\n`);
      console.log('Bot is ready to receive messages!\n');

      // Cleanup old chats (keep only active ones, e.g., last touched <1 day)
      const now = Date.now();
      for (const [jid, chatMsgs] of store.messages.entries()) {
        const timestamps = Array.from(chatMsgs.values()).map(m => m.messageTimestamp * 1000 || 0);
        if (timestamps.length > 0 && now - Math.max(...timestamps) > 24 * 60 * 60 * 1000) { // 1 day old chat
          store.messages.delete(jid);
        }
      }
      console.log(`🧹 Store cleaned. Active chats: ${store.messages.size}`);
    }
  });

  // Credentials update handler
  sock.ev.on('creds.update', saveCreds);

  // System JID filter - checks if JID is from broadcast/status/newsletter
  const isSystemJid = (jid) => {
    if (!jid) return true;
    return jid.includes('@broadcast') ||
      jid.includes('status.broadcast') ||
      jid.includes('@newsletter') ||
      jid.includes('@newsletter.');
  };

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

      // NOTE: the message is already cached by store.bind() above — this used to
      // run a second, expensive copy (sort + evict) on every single message.

      // Process command IMMEDIATELY (don't block on other operations)
      handler.handleMessage(sock, msg).catch(err => {
        if (!err.message?.includes('rate-overlimit') &&
          !err.message?.includes('not-authorized')) {
          console.error('Error handling message:', err.message);
        }
      });
    }
  });

  // Message receipt updates (silently handled, no logging)
  sock.ev.on('message-receipt.update', () => {
    // Silently handle receipt updates
  });

  // Message updates (silently handled, no logging)
  sock.ev.on('messages.update', () => {
    // Silently handle message updates
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

// Proactively delete Puppeteer cache so it doesn't fill disk on panels
cleanupPuppeteerCache();

startBot().catch(err => {
  console.error('Error starting bot:', err);
  process.exit(1);
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