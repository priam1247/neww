// test/verify.test.js — magic-byte container sniffing (no network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffContainer } from '../src/core/verify.js';

test('mp4: ftyp box at offset 4', () => {
  const b = Buffer.alloc(32, 0);
  b.write('ftyp', 4, 'ascii');
  assert.equal(sniffContainer(b), 'mp4');
});

test('mkv/webm: EBML header', () => {
  const b = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(28).fill(0)]);
  assert.equal(sniffContainer(b), 'mkv/webm');
});

test('avi: RIFF....AVI ', () => {
  const b = Buffer.alloc(32, 0);
  b.write('RIFF', 0, 'ascii');
  b.write('AVI ', 8, 'ascii');
  assert.equal(sniffContainer(b), 'avi');
});

test('mpegts: 0x47 sync bytes at 0 and 188', () => {
  const b = Buffer.alloc(256, 0);
  b[0] = 0x47; b[188] = 0x47;
  assert.equal(sniffContainer(b), 'mpegts');
});

test('junk returns null', () => {
  assert.equal(sniffContainer(Buffer.from('<html><body>error</body></html>')), null);
  assert.equal(sniffContainer(Buffer.alloc(8, 0x41)), null);
});
