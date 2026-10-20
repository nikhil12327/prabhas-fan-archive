// Extracts the five decorative merch images embedded in index.html (the `IM`
// array) and uploads them to the public `merch` bucket under the filenames the
// seeded products already reference (tee/poster/hoodie/print/cards.jpg).
//
//   set -a; . ./.env.local; set +a
//   node scripts/upload-merch-images.mjs
//
// Uses the service role key, which is why this is a local script and not
// something the browser can do.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Source .env.local first.');
  process.exit(1);
}

// --- pull IM out of the page ------------------------------------------
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const m = /const IM=\[([\s\S]*?)\];/.exec(html);
if (!m) { console.error('Could not find the IM array in public/index.html'); process.exit(1); }

const entries = [...m[1].matchAll(/"(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)"/g)].map(x => x[1]);
console.log(`found ${entries.length} embedded images in IM[]`);
if (entries.length !== 5) { console.error('Expected exactly 5.'); process.exit(1); }

// MG maps each product label to an IM index; keep the original pairing.
const mg = /const MG=\[([\s\S]*?)\];/.exec(html);
const labels = [...mg[1].matchAll(/\["([^"]+)","[^"]*",(\d)\]/g)].map(x => ({ name: x[1], idx: +x[2] }));
console.log('MG pairing:', labels.map(l => `${l.name}→IM[${l.idx}]`).join(', '));

// Seeded product filenames, matched to the same label → file mapping.
const FILE_FOR = {
  'T-shirts': 'tee.jpg',
  'Posters': 'poster.jpg',
  'Hoodies': 'hoodie.jpg',
  'Limited prints': 'print.jpg',
  'Collectible cards': 'cards.jpg',
};

const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'x-upsert': 'true',
};

let ok = 0;
for (const { name, idx } of labels) {
  const file = FILE_FOR[name];
  if (!file) { console.log(`  – no filename mapping for "${name}", skipped`); continue; }

  const uri = entries[idx];
  if (!uri) { console.log(`  ✗ IM[${idx}] missing for ${name}`); continue; }

  const [meta, b64] = uri.split(',');
  const mime = /data:([^;]+)/.exec(meta)[1];
  const buf = Buffer.from(b64, 'base64');

  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/merch/${file}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': mime },
    body: buf,
  });
  const text = await r.text();
  if (r.ok) { ok++; console.log(`  ✓ ${file.padEnd(12)} ${(buf.length / 1024).toFixed(0)} KB (${mime}) — ${name}`); }
  else { console.log(`  ✗ ${file}: ${r.status} ${text.slice(0, 160)}`); }
}

console.log(`\n${ok}/${labels.length} uploaded to the merch bucket`);

// --- verify public readability ----------------------------------------
console.log('\nverifying public URLs resolve:');
for (const file of Object.values(FILE_FOR)) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/merch/${file}`, { method: 'GET' });
  console.log(`  ${r.ok ? '✓' : '✗'} ${file} → HTTP ${r.status}`);
}

process.exit(ok === labels.length ? 0 : 1);
