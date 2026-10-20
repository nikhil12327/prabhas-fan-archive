// Project-wide syntax + structure gate: `npm run check`
// Checks every JS file, both inline <script> blocks, and the JSON configs.
// Exits non-zero on the first class of failure so CI/deploy can gate on it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let failures = 0;
const fail = m => { failures++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

// --- walk source files, skipping vendored/asset dirs -----------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.logs', 'images', 'screenshots'].includes(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
const js = files.filter(f => ['.js', '.mjs'].includes(extname(f)));

console.log('\nJS syntax (node --check, honours "type": "module")');
for (const f of js) {
  const rel = f.replace(root, '').replace(/^[/\\]/, '');
  try {
    // node --check parses .js as ESM when package.json says "type":"module",
    // which vm.Script cannot do — it always parses as a classic script.
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    ok(rel);
  } catch (e) {
    const msg = String(e.stderr || e.message).trim().split('\n').slice(0, 4).join(' | ');
    fail(`${rel}: ${msg}`);
  }
}

console.log('\nJSON configs');
for (const f of files.filter(f => extname(f) === '.json')) {
  try {
    JSON.parse(readFileSync(f, 'utf8'));
    ok(f.replace(root, '').replace(/^[/\\]/, ''));
  } catch (e) {
    fail(`${f}: ${e.message}`);
  }
}

console.log('\nInline scripts');
for (const f of files.filter(f => extname(f) === '.html')) {
  const html = readFileSync(f, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0, any = false;
  while ((m = re.exec(html))) {
    any = true;
    i++;
    try {
      new Script(m[1], { filename: `${f}#${i}` });
      ok(`${f.replace(root, '').replace(/^[/\\]/, '')} #${i}`);
    } catch (e) {
      fail(`${f} script #${i}: ${e.message}`);
    }
  }
  if (!any) console.log(`  – ${f.replace(root, '').replace(/^[/\\]/, '')} (no inline scripts)`);
}

console.log(`\n${failures ? `${failures} FAILURES` : 'All checks passed.'}\n`);
process.exit(failures ? 1 : 0);
