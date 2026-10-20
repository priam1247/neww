// test/extract.test.js — the COMPLETED unpacker + URL sniffers.
// 2.0's extract.js was truncated mid-function in the shipped source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpack, tryB64, tryHex, sniffUrls, sniffRedirect } from '../src/core/extract.js';

// classic low-radix packer payload (numeric tokens): words[0..5] map to 0..5
// "https|cdn|example|com|stream|m3u8" → https://cdn.example.com/stream.m3u8
const PACKED_LOW = `eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p}("0://1.2.3/4.5",10,10,"https|cdn|example|com|stream|m3u8".split("|"),0,{}))`;

test('unpack: low-radix numeric tokens reconstruct the URL', () => {
  const out = unpack(PACKED_LOW);
  assert.equal(out, 'https://cdn.example.com/stream.m3u8');
});

test('unpack: returns null for non-packed input', () => {
  assert.equal(unpack('plain html content'), null);
  assert.equal(unpack(''), null);
});

test('tryB64 extracts URLs from base64 blobs', () => {
  const enc = Buffer.from('https://cdn.host/video.m3u8').toString('base64');
  assert.equal(tryB64(enc), 'https://cdn.host/video.m3u8');
  assert.equal(tryB64('not base64 url'), null);
});

test('tryHex extracts URLs from hex blobs', () => {
  const enc = Buffer.from('https://cdn.host/video.mp4').toString('hex');
  assert.equal(tryHex(enc), 'https://cdn.host/video.mp4');
  assert.equal(tryHex('zzz'), null);
});

test('sniffUrls finds m3u8/mp4 URLs in JS blobs', () => {
  const js = `var src="https://cdn.host/master.m3u8";var alt='http://alt.host/file.mp4';`;
  const urls = sniffUrls(js);
  assert.ok(urls.includes('https://cdn.host/master.m3u8'));
  assert.ok(urls.includes('http://alt.host/file.mp4'));
});

test('sniffUrls decodes escaped slashes', () => {
  const js = `var u="https:\\/\\/cdn.host\\/hls\\/index.m3u8"`;
  assert.ok(sniffUrls(js).includes('https://cdn.host/hls/index.m3u8'));
});

test('sniffUrls decodes base64-embedded streams', () => {
  const enc = Buffer.from('source=https://cdn.host/playlist.m3u8').toString('base64');
  const js = `config = { data: "${enc}" };`;
  assert.ok(sniffUrls(js).some(u => u.includes('playlist.m3u8')));
});

test('sniffUrls unpacks packer payloads', () => {
  const urls = sniffUrls(PACKED_LOW);
  assert.ok(urls.includes('https://cdn.example.com/stream.m3u8'));
});

test('sniffRedirect catches meta refresh and JS redirects', () => {
  assert.equal(
    sniffRedirect('<meta http-equiv="refresh" content="0; url=https://go.here/file">'),
    'https://go.here/file'
  );
  assert.equal(sniffRedirect('window.location.href="https://js.land/x";'), 'https://js.land/x');
  assert.equal(sniffRedirect('nothing here'), null);
});
