// test/selfinstall.test.js — hermetic tests for the WhatsApp-adapter self-healer.
// Covers the decision switch, install args, and the never-throw contract; no
// network access is performed (the failing-cwd case resolves without npm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_SPECS, npmInstallArgs, shouldAutoInstall, selfInstall,
} from '../src/bot/selfinstall.js';

test('adapter specs cover baileys + qrcode-terminal', () => {
  assert.equal(ADAPTER_SPECS.length, 2);
  assert.ok(ADAPTER_SPECS[0].startsWith('@whiskeysockets/baileys@'));
  assert.ok(ADAPTER_SPECS[1].startsWith('qrcode-terminal@'));
});

test('npm args are quiet, non-mutating, and include the specs', () => {
  const args = npmInstallArgs(['pkg@1.2.3']);
  assert.equal(args[0], 'install');
  assert.ok(args.includes('--no-save'), 'must not mutate package.json');
  assert.ok(args.includes('--no-audit'));
  assert.ok(args.includes('--no-fund'));
  assert.ok(args.includes('--loglevel=error'));
  assert.ok(args.includes('pkg@1.2.3'));
});

test('auto-install switch: OFFLINE=1 and WA_AUTOSTALL=0 disable it', () => {
  assert.equal(shouldAutoInstall({}), true);
  assert.equal(shouldAutoInstall({ OFFLINE: '1' }), false);
  assert.equal(shouldAutoInstall({ WA_AUTOSTALL: '0' }), false);
  assert.equal(shouldAutoInstall({ WA_AUTOSTALL: '' }), true);
  assert.equal(shouldAutoInstall({ WA_AUTOSTALL: '1' }), true);
});

test('selfInstall resolves {ok:false} instead of throwing when npm cannot run', async () => {
  const res = await selfInstall({ cwd: '/nonexistent-zafar-selfinstall-cwd', timeoutMs: 500 });
  assert.equal(res.ok, false);
  assert.equal(typeof res.ms, 'number');
});

test('project .npmrc opts back into git deps (npm 12 EALLOWGIT fix)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const npmrc = await readFile(path.join(here, '..', '.npmrc'), 'utf8');
  assert.match(npmrc, /^allow-git=all$/m);
});
