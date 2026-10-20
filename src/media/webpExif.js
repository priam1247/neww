// src/media/webpExif.js — merged from Zafar-bot-main, but dependency-free.
// The old bot used node-webpmux to embed sticker-pack metadata; this module
// does the same thing with ~70 lines of RIFF binary surgery: WhatsApp reads
// the EXIF chunk of a webp sticker to display the pack name. Insertion is
// idempotent (an existing EXIF chunk is replaced) and never fatal — on any
// parse problem the original buffer is returned untouched (metadata is
// cosmetic; the sticker still works).
import crypto from 'node:crypto';

const FOURCC = (buf, off) => buf.toString('ascii', off, off + 4);

/**
 * Embed WhatsApp sticker-pack metadata into a webp buffer.
 * @param {Buffer} webp
 * @param {{packName?:string, publisher?:string, emoji?:string}} meta
 * @returns {Buffer} webp with an EXIF chunk (or the input unchanged)
 */
export function withStickerMetadata(webp, { packName = '', publisher = '', emoji = '📖' } = {}) {
  try {
    if (!webp || webp.length < 12 || FOURCC(webp, 0) !== 'RIFF' || FOURCC(webp, 8) !== 'WEBP') return webp;

    const json = {
      'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
      'sticker-pack-name': packName || 'ZaFarBot',
      ...(publisher ? { 'sticker-pack-publisher': publisher } : {}),
      emojis: [emoji],
    };

    // TIFF-style EXIF header that WhatsApp expects (same bytes every wa-bot uses)
    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([exifAttr, jsonBuf]);
    exif.writeUIntLE(jsonBuf.length, 14, 4);

    const chunk = Buffer.alloc(8 + exif.length + (exif.length % 2));
    chunk.write('EXIF', 0, 'ascii');
    chunk.writeUInt32LE(exif.length, 4);
    exif.copy(chunk, 8);

    // walk chunks: VP8X first if present; drop any existing EXIF chunk
    const out = [Buffer.from('RIFF\0\0\0\0WEBP', 'ascii')];
    let pos = 12;
    let inserted = false;
    while (pos + 8 <= webp.length) {
      const fourcc = FOURCC(webp, pos);
      const size = webp.readUInt32LE(pos + 4);
      if (!/^[\x20-\x7e]{4}$/.test(fourcc) || pos + 8 + size > webp.length) return webp; // malformed → bail
      const payload = webp.subarray(pos + 8, pos + 8 + size);
      const pad = size % 2 ? 1 : 0;

      if (fourcc === 'EXIF') { pos += 8 + size + pad; continue; }   // replace existing
      out.push(webp.subarray(pos, pos + 8 + size + pad));
      if (fourcc === 'VP8X' && !inserted) { out.push(chunk); inserted = true; }
      pos += 8 + size + pad;
    }
    if (!inserted) out.push(chunk);

    const body = Buffer.concat(out);
    body.writeUInt32LE(body.length - 8, 4);   // patch RIFF size
    return body;
  } catch {
    return webp;
  }
}

/** Read back the sticker-pack metadata (round-trip helper + tests). */
export function readStickerMetadata(webp) {
  try {
    if (!webp || webp.length < 12 || FOURCC(webp, 0) !== 'RIFF') return null;
    let pos = 12;
    while (pos + 8 <= webp.length) {
      const fourcc = FOURCC(webp, pos);
      const size = webp.readUInt32LE(pos + 4);
      if (fourcc === 'EXIF') {
        const payload = webp.subarray(pos + 8, pos + 8 + size);
        // the JSON starts after the 22-byte TIFF attribute block we wrote
        const start = payload.indexOf(Buffer.from('{"'));
        if (start === -1) return null;
        return JSON.parse(payload.subarray(start).toString('utf8'));
      }
      if (!/^[\x20-\x7e]{4}$/.test(fourcc) || pos + 8 + size > webp.length) return null;
      pos += 8 + size + (size % 2 ? 1 : 0);
    }
  } catch { return null; }
  return null;
}
