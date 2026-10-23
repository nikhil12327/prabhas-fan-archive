// Pushes environment variables from .env.local into the Vercel project.
// Secrets are uploaded as type "sensitive", so Vercel encrypts them and never
// returns their values — not via the API, the CLI, or the dashboard.
//
//   set -a; . ./.env.local; set +a
//   node scripts/set-vercel-env.mjs [--force]
//
// Idempotent by design: the current env list is fetched once, missing keys are
// created, existing plain keys are only rewritten when their value differs, and
// existing sensitive keys are left alone. Sensitive values cannot be read back
// for comparison, so rewriting one blindly would churn the secret on every run
// — pass --force to rotate them deliberately.
//
// SITE_URL is the stable production alias. Before the first deployment it is
// absent, and api/_lib.js falls back to VERCEL_URL, so nothing breaks either way.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT_ID = process.env.VERCEL_PROJECT_ID || 'prj_dkczwlzNhxBOaDPg70QNeFo2tXzf';
const TOKEN = process.env.VERCEL_TOKEN;
const FORCE = process.argv.includes('--force');

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

const SECRET = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'RAZORPAY_KEY_SECRET']);

// key → value. Omit anything not present or deliberately deferred.
const WANTED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OWNER_EMAIL',
  'SHIPPING_PAISE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'SITE_URL',
];

const api = async (path, opts = {}) => {
  const r = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
};

const create = (key, value) => api(`/v10/projects/${PROJECT_ID}/env`, {
  method: 'POST',
  body: JSON.stringify({
    key,
    value,
    type: SECRET.has(key) ? 'sensitive' : 'plain',
    target: ['production', 'preview'],
  }),
});

const drop = id => api(`/v9/projects/${PROJECT_ID}/env/${id}`, { method: 'DELETE' });

// One listing up front, reused for every decision below.
const listed = await api(`/v9/projects/${PROJECT_ID}/env`);
if (!listed.ok) {
  console.error(`Could not list environment variables: HTTP ${listed.status}`);
  process.exit(1);
}
const existing = new Map();
for (const e of listed.body.envs || []) {
  if (!existing.has(e.key)) existing.set(e.key, []);
  existing.get(e.key).push(e);
}

let created = 0, updated = 0, unchanged = 0, skipped = 0, failed = 0;

for (const key of WANTED) {
  const value = env[key];
  if (!value) { console.log(`  – ${key.padEnd(26)} not set locally, skipped`); skipped++; continue; }

  const found = existing.get(key) || [];

  if (!found.length) {
    const res = await create(key, value);
    if (res.ok) { created++; console.log(`  + ${key.padEnd(26)} ${SECRET.has(key) ? '[sensitive]' : 'created'}`); }
    else { failed++; console.log(`  ✗ ${key.padEnd(26)} ${res.body.error?.message || `HTTP ${res.status}`}`); }
    continue;
  }

  const hasSensitive = found.some(e => e.type === 'sensitive');

  // Sensitive values come back redacted, so equality cannot be checked.
  if (hasSensitive && !FORCE) {
    unchanged++;
    console.log(`  = ${key.padEnd(26)} present [sensitive]`);
    continue;
  }

  const same = found.length === 1 && found[0].value === value;
  if (same && !FORCE) {
    unchanged++;
    console.log(`  = ${key.padEnd(26)} unchanged`);
    continue;
  }

  // An existing key must be deleted before it can be replaced. If any delete
  // fails, leave the value alone rather than failing the create on a duplicate.
  const failedDelete = [];
  for (const e of found) {
    const res = await drop(e.id);
    if (!res.ok) { failedDelete.push(e); console.log(`  ✗ ${key.padEnd(26)} could not delete existing value (HTTP ${res.status})`); }
  }
  // Any surviving value would make the create below collide on a duplicate.
  if (failedDelete.length) { failed++; continue; }

  const res = await create(key, value);
  if (res.ok) { updated++; console.log(`  ~ ${key.padEnd(26)} updated`); }
  else { failed++; console.log(`  ✗ ${key.padEnd(26)} ${res.body.error?.message || `HTTP ${res.status}`}`); }
}

console.log(`\n${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
