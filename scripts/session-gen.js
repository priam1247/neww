#!/usr/bin/env node
// scripts/session-gen.js — headless SESSION_ID bootstrap.
//
// Pair ONCE (on any machine with internet — even your laptop) and get a
// SESSION_ID="ZaFarBot!…" string you can paste into any deployment
// (Pterodactyl egg variable, .env, docker-compose). The server then boots
// fully logged-in — no QR in the panel console, no pairing code needed.
//
// Usage:
//   node scripts/session-gen.js                 # QR appears here
//   node scripts/session-gen.js 265894016453    # pairing code for that number
//
// Keep the printed string secret — it IS the WhatsApp session.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.resolve('temp', 'session-gen');
const phone = process.argv[2] ? String(process.argv[2]).replace(/[^0-9]/g, '') : '';

let baileys;
try {
  baileys = await import('@whiskeysockets/baileys');
} catch {
  console.error('Baileys not installed — run: npm install');
  process.exit(1);
}
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

const silentLogger = ['error', 'warn', 'info', 'debug', 'trace'].reduce((acc, level) => {
  acc[level] = () => {};
  acc.child = () => silentLogger;
  return acc;
}, { level: 'silent', child: () => silentLogger });

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(OUT_DIR);
const sock = makeWASocket({
  auth: state,
  logger: silentLogger,
  printQRInTerminal: !phone,          // QR only when no number given
  browser: ['Ubuntu', 'Chrome', '131.0.0.0'],
  markOnlineOnConnect: false,
});

if (phone) {
  setTimeout(async () => {
    try {
      if (state.creds.registered) return;
      const code = await sock.requestPairingCode(phone);
      console.log(`\n🔗 Pairing code: ${code}`);
      console.log('On your phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead" → enter this code.');
    } catch (e) {
      console.error('pairing code failed:', e.message);
    }
  }, 3000);
} else {
  console.log('Scan the QR below with WhatsApp → Linked Devices:');
}

sock.ev.on('creds.update', saveCreds);
sock.ev.on('connection.update', async (u) => {
  const { connection, lastDisconnect } = u;

  if (connection === 'open') {
    // give the server a beat to flush creds.json before reading it
    await new Promise(r => setTimeout(r, 1500));
    try {
      const gz = zlib.gzipSync(fs.readFileSync(path.join(OUT_DIR, 'creds.json')));
      console.log('\n✅ paired. Your session string (keep it secret):\n');
      console.log(`SESSION_ID=ZaFarBot!${gz.toString('base64')}`);
      console.log('\nSet it as the SESSION_ID egg variable / .env value. On first boot the bot');
      console.log('writes creds.json from it and never overwrites an existing session.');
      console.log('Now delete temp/session-gen (it holds live credentials).');
    } catch (e) {
      console.error('could not read creds.json:', e.message);
    }
    try { sock.end(new Error('done')); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 500);
    return;
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      console.error('\nlogged out — re-run the script to start over.');
      process.exit(1);
    }
    console.error(`\nconnection closed (${code}) — just re-run: node scripts/session-gen.js${phone ? ' ' + phone : ''}`);
    process.exit(1);
  }
});
