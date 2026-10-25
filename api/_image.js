// Server-side image validation for api/moderate.js — zero dependencies.
//
// The browser's `f.type` and the storage object's content-type are both
// CLIENT-CLAIMED values; an attacker can label an HTML or SVG payload as
// image/jpeg. Before anything is published to the public `wall` bucket we
// inspect the actual bytes: container signature, decodable structure and
// pixel dimensions (decompression-bomb guard).
//
// Accepted: JPEG, PNG, WebP (lossy + lossless). Everything else — HTML,
// SVG, scripts, malformed or truncated files — is rejected with a reason.

export const MAX_BYTES = 8 * 1024 * 1024;      // matches the bucket limit
export const MAX_SIDE = 8000;                  // px per side
export const MAX_PIXELS = 40_000_000;          // 40 MP decompression-bomb cap
export const MIN_SIDE = 16;                    // junk/pixel fodder

const u8 = (buf, i) => buf[i];
const u16be = (buf, i) => (buf[i] << 8) | buf[i + 1];
const u32be = (buf, i) => ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];

const startsWith = (buf, bytes, offset = 0) =>
  bytes.every((b, i) => buf[offset + i] === b);

/** Dimensions from a JPEG byte stream by walking markers to a SOFn frame. */
function jpegSize(buf) {
  let i = 2; // skip SOI
  while (i + 9 < buf.length) {
    if (u8(buf, i) !== 0xff) { i++; continue; }         // resync on fill bytes
    const marker = u8(buf, i + 1);
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = u16be(buf, i + 2);
    if (len < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (i + 9 >= buf.length) return null;
      return { height: u16be(buf, i + 5), width: u16be(buf, i + 7) };
    }
    if (marker === 0xda) return null;                   // reached scan data: no frame header
    i += 2 + len;
  }
  return null;
}

/** Dimensions from a WebP container (VP8X / VP8L / VP8). */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = String.fromCharCode(...buf.subarray(12, 16));
  if (fourcc === 'VP8X') {
    const width = 1 + (u8(buf, 24) | (u8(buf, 25) << 8) | (u8(buf, 26) << 16));
    const height = 1 + (u8(buf, 27) | (u8(buf, 28) << 8) | (u8(buf, 29) << 16));
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    if (u8(buf, 20) !== 0x2f) return null;
    const b0 = u8(buf, 21), b1 = u8(buf, 22), b2 = u8(buf, 23), b3 = u8(buf, 24);
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    // lossy: 3-byte frame tag, 3-byte sync code 9d 01 2a, then 14-bit dims
    if (u8(buf, 23) !== 0x9d || u8(buf, 24) !== 0x01 || u8(buf, 25) !== 0x2a) return null;
    const width = u16be(buf, 26) & 0x3fff;
    const height = u16be(buf, 28) & 0x3fff;
    return { width, height };
  }
  return null;
}

/**
 * Validate an image buffer.
 * @returns {{ok: true, type: string, ext: string, width: number, height: number}}
 *        | {{ok: false, reason: string}}
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, reason: 'empty file' };
  if (buf.length > MAX_BYTES) return { ok: false, reason: 'file is larger than 8 MB' };

  let type = null, ext = null, dims = null;

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // PNG: signature + IHDR must be the first chunk
    if (buf.length < 33 || String.fromCharCode(...buf.subarray(12, 16)) !== 'IHDR') {
      return { ok: false, reason: 'malformed PNG (no IHDR)' };
    }
    dims = { width: u32be(buf, 16), height: u32be(buf, 20) };
    type = 'image/png'; ext = 'png';
  } else if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    dims = jpegSize(buf);
    if (!dims) return { ok: false, reason: 'malformed JPEG (no frame header)' };
    type = 'image/jpeg'; ext = 'jpg';
  } else if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
             startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    dims = webpSize(buf);
    if (!dims) return { ok: false, reason: 'malformed WebP' };
    type = 'image/webp'; ext = 'webp';
  } else {
    // Explicitly call out the payloads attackers actually try to smuggle.
    const head = buf.subarray(0, 512).toString('latin1');
    if (/^\s*<(\?xml|!doctype|html|svg|body)/i.test(head)) {
      return { ok: false, reason: 'file is HTML/SVG markup, not an image' };
    }
    if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { ok: false, reason: 'GIF is not accepted' };
    if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return { ok: false, reason: 'PDF is not accepted' };
    return { ok: false, reason: 'unrecognised file signature (not JPEG, PNG or WebP)' };
  }

  const { width, height } = dims;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_SIDE || height < MIN_SIDE) {
    return { ok: false, reason: 'image dimensions are invalid' };
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    return { ok: false, reason: `image is ${width}×${height}; the limit is ${MAX_SIDE}px per side` };
  }
  if (width * height > MAX_PIXELS) {
    return { ok: false, reason: 'image has too many pixels' };
  }

  return { ok: true, type, ext, width, height };
}
