// Generates public/config.js at build time from environment variables.
// The browser needs only the Supabase URL and the anon key (both public by
// design, guarded by row level security). Service-role keys never appear here.
//
// Run automatically by Vercel's buildCommand; run manually with:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-config.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'config.js');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl || !anonKey) {
  // Not fatal: the site still renders, just without the connected features.
  console.warn('[config] SUPABASE_URL / SUPABASE_ANON_KEY not set — writing a disabled config.');
}

const config = {
  supabaseUrl,
  anonKey,
  enabled: Boolean(supabaseUrl && anonKey),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `// GENERATED FILE — do not edit. Created by scripts/build-config.mjs.\n` +
    `window.__ARCHIVE_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`
);
console.log(`[config] wrote ${out} (enabled: ${config.enabled})`);
