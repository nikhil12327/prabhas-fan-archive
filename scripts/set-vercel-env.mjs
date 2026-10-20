// Pushes environment variables from .env.local into the Vercel project.
// Secrets are uploaded as type "sensitive", so Vercel encrypts them and never
// returns their values — not via the API, the CLI, or the dashboard.
//
//   set -a; . ./.env.local; set +a
//   node scripts/set-vercel-env.mjs
//
// SITE_URL is the stable production alias. Before the first deployment it is
// absent, and api/_lib.js falls back to VERCEL_URL, so nothing breaks either way.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_dkczwlzNhxBOaDPg70QNeFo2tXzf';
const TOKEN = process.env.VERCEL_TOKEN;

if (!TOKEN) { console.error('VERCEL_TOKEN missing. Source .env.local first.'); process.exit(1); }

// Parse .env.local without exporting it to the child world.
const raw = readFileSync(join(root, '.env.local'), 'utf8');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const SECRET = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY']);

// key → value. Omit anything not present or deliberately deferred.
const WANTED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OWNER_EMAIL',
  'SHIPPING_PAISE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SITE_URL',
];

// `replace` guards the delete-and-retry path: without it a delete that does not
// take effect would recurse forever on the same "already exists" error.
async function addEnv(key, value, replace = false) {
  const body = {
    key,
    value,
    type: SECRET.has(key) ? 'sensitive' : 'plain',
    target: ['production', 'preview'],
  };
  const r = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    // An existing key must be deleted before it can be replaced.
    if (out.error && /already exists|duplicate/i.test(out.error.message || '')) {
      const list = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}/env`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }).then(x => x.json());
      const existing = (list.envs || []).filter(e => e.key === key);
      for (const e of existing) {
        await fetch(`https://api.vercel.com/v3/projects/${PROJECT_ID}/env/${e.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
      }
      if (replace) return { ok: false, error: 'still exists after delete' };
      return addEnv(key, value, true);
    }
    return { ok: false, error: out.error?.message || `HTTP ${r.status}` };
  }
  return { ok: true };
}

let ok = 0, fail = 0;
for (const key of WANTED) {
  const value = env[key];
  if (!value) { console.log(`  – ${key.padEnd(26)} not set locally, skipped`); continue; }
  const res = await addEnv(key, value);
  if (res.ok) { ok++; console.log(`  ✓ ${key.padEnd(26)} ${SECRET.has(key) ? '[sensitive]' : ''}`); }
  else { fail++; console.log(`  ✗ ${key.padEnd(26)} ${res.error}`); }
}

console.log(`\n${ok} set, ${fail} failed`);
process.exit(fail ? 1 : 0);
