// XSS regression tests for public/sanitize.js — the canonical output encoders
// used by the site, the photo wall/merch UI and the admin dashboard.
//
// Payloads are built with String.fromCharCode so this file itself never
// depends on HTML entities surviving transport.
//
//   node scripts/test-sanitize.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// sanitize.js ships as a CLASSIC browser script (no export statements), so
// evaluate it exactly the way a browser would and pull the global it sets.
const source = readFileSync(new URL('../public/sanitize.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
new vm.Script(source, { filename: 'public/sanitize.js' }).runInContext(sandbox);
const S = sandbox.ArchiveSanitize || sandbox.module.exports;
if (typeof S.esc !== 'function') {
  console.error('  ✗ public/sanitize.js did not expose ArchiveSanitize');
  process.exit(1);
}

const AMP = String.fromCharCode(38);
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const QUOT = String.fromCharCode(34);
const APOS = String.fromCharCode(39);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\npublic/sanitize.js — esc()\n');

{
  const payload = LT + 'img src=x onerror=alert(1)' + GT;
  const out = S.esc(payload);
  check('tag injection becomes text (no raw < >)',
    !out.includes(LT) && !out.includes(GT) &&
    out.includes(AMP + 'lt;') && out.includes(AMP + 'gt;'),
    JSON.stringify(out));
}
{
  const out = S.esc(QUOT + ' onmouseover=' + APOS + 'stolen' + APOS);
  check('attribute breakout quotes are encoded',
    !out.includes(QUOT) && !out.includes(APOS) &&
    out.includes(AMP + 'quot;') && out.includes(AMP + '#39;'),
    JSON.stringify(out));
}
{
  const out = S.esc(AMP + 'lt;script' + GT);
  check('ampersand is double-encoded (no entity smuggling)',
    !out.includes(AMP + 'lt;') || out.startsWith(AMP + 'amp;'),
    JSON.stringify(out));
}
check('null/undefined render empty', S.esc(null) === '' && S.esc(undefined) === '');
check('numbers survive as text', S.esc(12) === '12');

console.log('\npublic/sanitize.js — safeUrl()\n');

check('javascript: URL is rejected', S.safeUrl('javascript:alert(1)') === '');
check('mixed-case JAVASCRIPT: is rejected', S.safeUrl('JaVaScRiPt:alert(1)') === '');
check('tab/newline obfuscated scheme is rejected', S.safeUrl('java\tscript:alert(1)') === '');
check('leading-space scheme is rejected', S.safeUrl(' javascript:alert(1)') === '');
check('data: URL is rejected', S.safeUrl('data:text/html,' + LT + 'script' + GT) === '');
check('vbscript: is rejected', S.safeUrl('vbscript:msgbox(1)') === '');
check('protocol-relative URL is rejected', S.safeUrl('//evil.example/x') === '');
check('https CDN URL passes', S.safeUrl('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/x.js') ===
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/x.js');
check('same-origin path passes', S.safeUrl('/images/upi-qr.png') === '/images/upi-qr.png');
check('upi: deep link passes', S.safeUrl('upi://pay?pa=a@b&am=1') === 'upi://pay?pa=a@b&am=1');
check('mailto: passes', S.safeUrl('mailto:f@example.com') === 'mailto:f@example.com');
check('scheme-less junk is rejected', S.safeUrl('alert(1)') === '');

console.log('\npublic/sanitize.js — safePath()\n');

check('normal storage filename passes', S.safePath('approved-9f2c.jpg') === 'approved-9f2c.jpg');
check('path traversal is rejected', S.safePath('../../etc/passwd') === '');
check('embedded slash is rejected', S.safePath('a/b.jpg') === '');
check('backslash is rejected', S.safePath('a\\b.jpg') === '');
check('quote/injection filename is rejected', S.safePath('x"onerror="alert(1)') === '');
check('empty is rejected', S.safePath('') === '');
check('overlong path is rejected', S.safePath('a'.repeat(200)) === '');

console.log('\npublic/sanitize.js — num()\n');

check('numeric string coerces', S.num('12') === 12);
check('garbage coerces to 0', S.num('hack') === 0 && S.num(null) === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
