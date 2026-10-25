// Tests for api/_image.js — the byte-level gate that runs before anything
// from the private `submissions` bucket is copied to the public `wall`.
// Fixtures are hand-built so no image binaries live in the repo.
//
//   node scripts/test-image.mjs

const { sniffImage, MAX_BYTES, MAX_SIDE } = await import('../api/_image.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function png(width, height) {
  const b = Buffer.alloc(33);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v));
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width, height) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0xffd8, 0);   // SOI
  b[2] = 0xff; b[3] = 0xc0;     // SOF0
  b.writeUInt16BE(17, 4);       // segment length
  b[6] = 8;                     // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

function webp(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  const w = width - 1, h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

console.log('\napi/_image.js — accepted formats\n');

{
  const r = sniffImage(png(800, 600));
  check('valid PNG accepted with dimensions', r.ok && r.type === 'image/png' && r.ext === 'png' && r.width === 800 && r.height === 600, JSON.stringify(r));
}
{
  const r = sniffImage(jpeg(1024, 768));
  check('valid JPEG accepted with dimensions', r.ok && r.type === 'image/jpeg' && r.ext === 'jpg' && r.width === 1024 && r.height === 768, JSON.stringify(r));
}
{
  const r = sniffImage(webp(640, 480));
  check('valid WebP (VP8X) accepted with dimensions', r.ok && r.type === 'image/webp' && r.ext === 'webp' && r.width === 640 && r.height === 480, JSON.stringify(r));
}

console.log('\napi/_image.js — hostile payloads\n');

{
  const html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
  const r = sniffImage(html);
  check('HTML posing as an image is rejected', !r.ok && /HTML\/SVG|signature/i.test(r.reason), JSON.stringify(r));
}
{
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const r = sniffImage(svg);
  check('SVG with a script handler is rejected', !r.ok, JSON.stringify(r));
}
{
  const gif = Buffer.from('GIF89a' + 'x'.repeat(64));
  const r = sniffImage(gif);
  check('GIF (not on the allow-list) is rejected', !r.ok && /GIF/.test(r.reason), JSON.stringify(r));
}
{
  const pdf = Buffer.from('%PDF-1.7 ' + 'x'.repeat(64));
  const r = sniffImage(pdf);
  check('PDF is rejected', !r.ok && /PDF/.test(r.reason), JSON.stringify(r));
}
{
  const r = sniffImage(png(9000, 100));
  check(`wider than ${MAX_SIDE}px is rejected`, !r.ok && /9000|limit/.test(r.reason), JSON.stringify(r));
}
{
  const r = sniffImage(png(7000, 7000)); // 49 MP > 40 MP
  check('decompression-bomb pixel count is rejected', !r.ok && /pixels/.test(r.reason), JSON.stringify(r));
}
{
  const big = png(800, 600);
  const oversize = Buffer.concat([big, Buffer.alloc(MAX_BYTES + 1)]);
  const r = sniffImage(oversize);
  check('a file over 8 MB is rejected', !r.ok && /8 MB/.test(r.reason), JSON.stringify(r));
}
{
  const r = sniffImage(png(10, 10)); // below MIN_SIDE
  check('degenerate dimensions are rejected', !r.ok, JSON.stringify(r));
}
{
  const r = sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00]));
  check('a truncated JPEG is rejected', !r.ok && /malformed JPEG/.test(r.reason), JSON.stringify(r));
}
{
  const r = sniffImage(Buffer.alloc(0));
  check('an empty file is rejected', !r.ok, JSON.stringify(r));
}
{
  // Trailing junk after a valid PNG header does not change the verdict —
  // the point is the CONTAINER decides, not the filename/claimed type.
  const r = sniffImage(Buffer.concat([png(800, 600), Buffer.from('<script>alert(1)</script>')]));
  check('a valid PNG container still parses by structure alone',
    r.ok && r.type === 'image/png' && r.width === 800, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
