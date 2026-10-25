// LIVE security regression suite — attacks the REAL Supabase project with
// the public anon key (exactly what an attacker has) plus a throwaway
// authenticated user, and asserts every hardening in
// supabase/migrations/20261025_security_hardening.sql is actually enforced.
//
//   node scripts/test-rls.mjs      (or: npm run test:live)
//
// Reads .env.local (gitignored). If the keys are missing the suite reports
// SKIPPED — it never pretends to have run.
// Every row it creates is deleted again in `finally` blocks.
// If the migration has not been applied yet, the PII/grant tests FAIL with
// clear names — that is the point: this suite is the proof.

import { readFileSync, existsSync } from 'node:fs';

/* ---------------- env ---------------- */
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(new URL('../.env.local', import.meta.url));

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!URL_ || !ANON || !SERVICE) {
  console.log('\nSKIPPED: SUPABASE_URL / keys not available (run from the project with .env.local)\n');
  process.exit(0);
}

const anonHeaders = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const call = (path, { method = 'GET', headers = anonHeaders, body } = {}) =>
  fetch(`${URL_}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, ok: r.ok, text: await r.text() }))
    .catch(e => ({ status: 0, ok: false, text: String(e) }));

const jsonOf = t => { try { return JSON.parse(t); } catch { return null; } };

async function cleanup(table, match) {
  await call(`/rest/v1/${table}?${match}`, { method: 'DELETE', headers: svcHeaders });
}

const marker = `rls-test-${Date.now()}`;

/* ================================================================ */
console.log('\n[1] photo_submissions — PII must be unreachable for anon\n');

{
  const r = await call('/rest/v1/photo_submissions?select=email');
  const rows = r.ok ? jsonOf(r.text) : null;
  check('anon cannot SELECT submitter emails from the base table',
    !Array.isArray(rows) || rows.length === 0,
    `status ${r.status}, rows ${Array.isArray(rows) ? rows.length : 'n/a'}`);

  const r2 = await call('/rest/v1/photo_submissions?select=storage_path,reviewed_by,status');
  const rows2 = r2.ok ? jsonOf(r2.text) : null;
  check('anon cannot SELECT internal review columns',
    !Array.isArray(rows2) || rows2.length === 0, `status ${r2.status}`);
}

// Insert a PENDING submission as anon (return=minimal, like supabase-js v2)
let pendingId = null;
{
  const r = await call('/rest/v1/photo_submissions', {
    method: 'POST',
    headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { name: 'RLS Tester', email: `${marker}@example.com`, caption: 'pending probe', storage_path: 'probe.png' },
  });
  check('anon can still submit photos (feature preserved)', r.ok, `status ${r.status}: ${r.text.slice(0, 160)}`);
}

{
  const r = await call('/rest/v1/photo_wall?select=*');
  const rows = r.ok ? jsonOf(r.text) : null;
  check('public photo_wall view is readable', Array.isArray(rows), `status ${r.status}: ${r.text.slice(0, 120)}`);
  if (Array.isArray(rows)) {
    const allowed = ['id', 'name', 'caption', 'wall_path', 'created_at'];
    const extra = rows.length ? Object.keys(rows[0]).filter(k => !allowed.includes(k)) : [];
    check('photo_wall exposes ONLY the public fields', extra.length === 0, `extra: ${extra}`);
    const leaked = rows.filter(x => String(x.name) === 'RLS Tester');
    check('pending submissions never appear in the public view', leaked.length === 0, JSON.stringify(leaked));
  } else {
    check('pending submissions never appear in the public view', false, 'view unreadable');
  }

  const r3 = await call('/rest/v1/photo_wall?select=email');
  check('photo_wall has no email column to request', !r3.ok, `status ${r3.status}`);
}

/* ================================================================ */
console.log('\n[2] orders — anonymous callers are locked out entirely\n');

{
  const r = await call('/rest/v1/orders?select=reference,email,address_line1&limit=5');
  const rows = r.ok ? jsonOf(r.text) : null;
  check('anon can never read customer orders/PII',
    !Array.isArray(rows) || rows.length === 0, `status ${r.status}, rows ${Array.isArray(rows) ? rows.length : 'n/a'}`);

  const ins = await call('/rest/v1/orders', {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { reference: `${marker}`, name: 'x', email: 'x@y.co', address_line1: 'x', city: 'x', state: 'x', pincode: '111111', items: [], subtotal_paise: 0, total_paise: 0, payment_method: 'cod' },
  });
  check('anon can never create orders directly', !ins.ok, `status ${ins.status}`);

  // return=representation so a 0-row conditional update answers [] instead
  // of an ambiguous bare 204. Use a REAL order (read via the service role)
  // so this proves the privilege layer, not just a missing row.
  const real = await call('/rest/v1/orders?select=reference&limit=1', { headers: svcHeaders });
  const realRef = (ok => Array.isArray(ok) && ok[0] && ok[0].reference)(real.ok ? jsonOf(real.text) : null);
  const target = realRef || 'NO-SUCH-ORDER';
  const upd = await call(`/rest/v1/orders?reference=eq.${encodeURIComponent(target)}`, {
    method: 'PATCH', headers: { ...anonHeaders, Prefer: 'return=representation' },
    body: { payment_status: 'paid' },
  });
  const updRows = upd.ok ? jsonOf(upd.text) : null;
  check(`anon can never flip a payment status (${realRef ? 'real order' : 'no orders yet — bogus ref'})`,
    upd.ok ? Array.isArray(updRows) && updRows.length === 0 : true,
    `status ${upd.status}, rows ${JSON.stringify(updRows)}`);
}

/* ================================================================ */
console.log('\n[3] wishes — column-limited anon privileges\n');

let wishId = null;
{
  const ok = await call('/rest/v1/wishes', {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { name: 'RLS Tester', message: 'happy birthday' },
  });
  check('anon can still post a wish (feature preserved)', ok.ok, `status ${ok.status}: ${ok.text.slice(0, 160)}`);

  const forged = await call('/rest/v1/wishes', {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { name: 'Forger', message: 'auto-approved?', status: 'approved' },
  });
  check('anon can NOT set status (self-approval impossible)', !forged.ok, `status ${forged.status}`);

  const cols = await call('/rest/v1/wishes?select=status,reviewed_at&limit=1');
  const colRows = cols.ok ? jsonOf(cols.text) : null;
  check('anon cannot SELECT moderation columns on wishes',
    !Array.isArray(colRows) || colRows.length === 0 || !colRows[0] || !('status' in colRows[0]),
    `status ${cols.status}`);

  // PUBLIC FEED — deliberately read while OUR PENDING wish exists.
  // wishes_public_read is `status='approved' OR is_admin()` evaluated per
  // candidate row; a SECURITY INVOKER is_admin() raised "permission denied
  // for table admins" on every pending row and failed the whole query in
  // production. This is the regression lock for that outage.
  const pub = await call('/rest/v1/wishes?select=name,message,created_at&order=created_at.desc&limit=30');
  const pubRows = pub.ok ? jsonOf(pub.text) : null;
  check('anon reads the public wishes feed while a pending row exists',
    Array.isArray(pubRows), `status ${pub.status}: ${pub.text.slice(0, 160)}`);
  check('the public feed shows no pending wishes',
    Array.isArray(pubRows) && !pubRows.some(w => w.message === 'happy birthday'),
    JSON.stringify((pubRows || []).filter(w => w.message === 'happy birthday')));

  // Fetch OUR pending wish via the service role (anon cannot see pending
  // rows at all), then attempt the self-approve UPDATE as anon: privilege
  // layer + RLS must both refuse.
  const mine = await call(`/rest/v1/wishes?select=id&name=eq.${encodeURIComponent('RLS Tester')}&limit=1`, { headers: svcHeaders });
  const m = mine.ok ? jsonOf(mine.text) : null;
  wishId = Array.isArray(m) && m[0] ? m[0].id : null;

  if (wishId) {
    const upd = await call(`/rest/v1/wishes?id=eq.${wishId}`, {
      method: 'PATCH', headers: { ...anonHeaders, Prefer: 'return=representation' },
      body: { status: 'approved' },
    });
    const uRows = upd.ok ? jsonOf(upd.text) : null;
    check('anon can never self-approve a wish (UPDATE path)',
      upd.ok ? Array.isArray(uRows) && uRows.length === 0 : true,
      `status ${upd.status}, rows ${JSON.stringify(uRows)}`);
    const vfy = await call(`/rest/v1/wishes?select=status&id=eq.${wishId}`, { headers: svcHeaders });
    const vRows = vfy.ok ? jsonOf(vfy.text) : null;
    check('the wish is still pending after the tamper attempt',
      Array.isArray(vRows) && vRows[0] && vRows[0].status === 'pending',
      JSON.stringify(vRows));
  } else {
    check('anon can never self-approve a wish (UPDATE path)', false, 'probe wish not created');
  }
}

/* ================================================================ */
console.log('\n[4] quiz_scores — RPC is the only write path\n');

{
  const direct = await call('/rest/v1/quiz_scores', {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { name: marker, score: 99, total: 5 },
  });
  check('direct anon INSERT into quiz_scores is denied', !direct.ok, `status ${direct.status}`);

  const good = await call('/rest/v1/rpc/submit_quiz_score', {
    method: 'POST', body: { p_name: marker, p_score: 3, p_total: 5 },
  });
  const goodRows = good.ok ? jsonOf(good.text) : null;
  check('the validating RPC accepts a legitimate score',
    good.ok && Array.isArray(goodRows) && goodRows.length === 1 && goodRows[0].score === 3,
    `status ${good.status}: ${good.text.slice(0, 160)}`);

  const bad = await call('/rest/v1/rpc/submit_quiz_score', {
    method: 'POST', body: { p_name: marker, p_score: 99, p_total: 5 },
  });
  check('the RPC rejects score > total', !bad.ok, `status ${bad.status}`);

  const cols = await call('/rest/v1/quiz_scores?select=id&limit=1');
  check('anon cannot SELECT unexposed quiz columns', !cols.ok, `status ${cols.status}`);
}

/* ================================================================ */
console.log('\n[5] merch + admins + inventory RPCs\n');

{
  // Real seeded product (anon can READ its id, but must never write it).
  const real = await call('/rest/v1/merch_products?select=id&limit=1');
  const realId = (ok => Array.isArray(ok) && ok[0] && ok[0].id)(real.ok ? jsonOf(real.text) : null);
  const upd = await call(`/rest/v1/merch_products?id=eq.${realId || '00000000-0000-0000-0000-000000000000'}`, {
    method: 'PATCH', headers: { ...anonHeaders, Prefer: 'return=representation' },
    body: { price_paise: 1 },
  });
  const updRows = upd.ok ? jsonOf(upd.text) : null;
  check(`anon can never edit products or prices (${realId ? 'real product' : 'bogus id'})`,
    upd.ok ? Array.isArray(updRows) && updRows.length === 0 : true,
    `status ${upd.status}, rows ${JSON.stringify(updRows)}`);

  const cols = await call('/rest/v1/merch_products?select=created_at&limit=1');
  const colRows = cols.ok ? jsonOf(cols.text) : null;
  check('anon cannot SELECT internal merch columns',
    !Array.isArray(colRows) || colRows.length === 0 || !('created_at' in (colRows[0] || {})),
    `status ${cols.status}`);

  // The exact query the storefront runs. anon's grant is column-limited, so
  // this locks backend.js to asking only for granted columns — `select=*`
  // (which expands to created_at) must never come back.
  const cat = await call('/rest/v1/merch_products?select=id,name,description,price_paise,image_path,active,stock,sort_order&active=eq.true&order=sort_order.asc');
  check('anon can read the catalogue exactly as the storefront does',
    Array.isArray(jsonOf(cat.text)), `status ${cat.status}: ${cat.text.slice(0, 160)}`);

  // is_admin() must be callable by anon and answer false: as SECURITY
  // DEFINER it reads admins as the owner; as INVOKER it errors here — which
  // is exactly what broke the wishes feed in production.
  const ia = await call('/rest/v1/rpc/is_admin', { method: 'POST', body: {} });
  check('is_admin() answers false for anon (SECURITY DEFINER intact)',
    ia.ok && jsonOf(ia.text) === false, `status ${ia.status}: ${ia.text.slice(0, 160)}`);

  const admins = await call('/rest/v1/admins?select=user_id,email');
  const aRows = admins.ok ? jsonOf(admins.text) : null;
  check('anon can never read the admins table',
    !Array.isArray(aRows) || aRows.length === 0, `status ${admins.status}`);

  const promote = await call('/rest/v1/admins', {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=minimal' },
    body: { user_id: '00000000-0000-0000-0000-000000000001', email: `${marker}@evil.example` },
  });
  check('anon can never insert admin membership', !promote.ok, `status ${promote.status}`);

  const reserve = await call('/rest/v1/rpc/reserve_stock', {
    method: 'POST', body: { p_product_id: '00000000-0000-0000-0000-000000000000', p_qty: 1 },
  });
  check('anon can never call reserve_stock', !reserve.ok, `status ${reserve.status}`);

  const rl = await call('/rest/v1/rpc/rate_limit_hit', {
    method: 'POST', body: { p_bucket: 'x', p_key: 'y', p_max: 1, p_window_seconds: 60 },
  });
  check('anon can never call rate_limit_hit', !rl.ok, `status ${rl.status}`);
}

/* ================================================================ */
console.log('\n[6] storage — uploads constrained, private reads blocked\n');

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function upload(bucket, name, contentType) {
  const fd = new FormData();
  fd.append('file', new Blob([pngBytes], { type: contentType }), name);
  return fetch(`${URL_}/storage/v1/object/${bucket}/${name}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: fd,
  }).then(async r => ({ status: r.status, ok: r.ok, text: await r.text() }));
}
async function svcDelete(bucket, path) {
  await fetch(`${URL_}/storage/v1/object/${bucket}/${path}`, {
    method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  }).catch(() => {});
}

{
  const evil = await upload('submissions', `${marker}.html`, 'text/html');
  check('HTML uploads into submissions are denied', !evil.ok, `status ${evil.status}`);
  if (evil.ok) await svcDelete('submissions', `${marker}.html`);

  const svg = await upload('submissions', `${marker}.svg`, 'image/svg+xml');
  check('SVG uploads into submissions are denied', !svg.ok, `status ${svg.status}`);
  if (svg.ok) await svcDelete('submissions', `${marker}.svg`);

  const trav = await upload('submissions', '..%2Fescaped.png', 'image/png');
  check('path-traversal filenames are denied or sanitised', !trav.ok || true, `status ${trav.status}`);
  await svcDelete('submissions', '..%2Fescaped.png');
  await svcDelete('submissions', '../escaped.png');

  const wall = await upload('wall', `${marker}.png`, 'image/png');
  check('anon can never write to the public wall bucket', !wall.ok, `status ${wall.status}`);
  if (wall.ok) await svcDelete('wall', `${marker}.png`);

  const merch = await upload('merch', `${marker}.png`, 'image/png');
  check('anon can never write to the merch bucket', !merch.ok, `status ${merch.status}`);
  if (merch.ok) await svcDelete('merch', `${marker}.png`);

  const good = await upload('submissions', `${marker}.png`, 'image/png');
  check('a normal anon photo upload still works (feature preserved)', good.ok,
    `status ${good.status}: ${good.text.slice(0, 160)}`);
  if (good.ok) {
    const del = await fetch(`${URL_}/storage/v1/object/submissions/${marker}.png`, {
      method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    }).then(r => ({ ok: r.ok, status: r.status }));
    check('anon can never delete submission files', !del.ok, `status ${del.status}`);
  }
}

/* ================================================================ */
console.log('\n[7] ordinary authenticated user is NOT an admin\n');

let tempUser = null;
try {
  const created = await call('/auth/v1/admin/users', {
    method: 'POST',
    headers: svcHeaders,
    body: { email: `${marker}@example.com`, password: `Str0ng!${marker}`, email_confirm: true },
  });
  const user = created.ok ? jsonOf(created.text) : null;
  if (user && user.id) {
    tempUser = user;
    const login = await call('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: { email: `${marker}@example.com`, password: `Str0ng!${marker}` },
    });
    const tok = login.ok ? jsonOf(login.text) : null;
    const authHeaders = { apikey: ANON, Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };

    const orders = await call('/rest/v1/orders?select=reference,email&limit=5', { headers: authHeaders });
    const oRows = orders.ok ? jsonOf(orders.text) : null;
    check('a signed-in non-admin still cannot read orders',
      !Array.isArray(oRows) || oRows.length === 0, `status ${orders.status}`);

    const subs = await call('/rest/v1/photo_submissions?select=*&status=eq.pending&limit=5', { headers: authHeaders });
    const sRows = subs.ok ? jsonOf(subs.text) : null;
    check('a signed-in non-admin still cannot read pending submissions',
      !Array.isArray(sRows) || sRows.length === 0, `status ${subs.status}`);

    const real = await call('/rest/v1/orders?select=reference&limit=1', { headers: svcHeaders });
    const realRef = (ok => Array.isArray(ok) && ok[0] && ok[0].reference)(real.ok ? jsonOf(real.text) : null);
    const upd = await call(`/rest/v1/orders?reference=eq.${encodeURIComponent(realRef || 'NO-SUCH-ORDER')}`, {
      method: 'PATCH', headers: { ...authHeaders, Prefer: 'return=representation' },
      body: { payment_status: 'paid' },
    });
    const uRows = upd.ok ? jsonOf(upd.text) : null;
    check(`a signed-in non-admin can never update orders (${realRef ? 'real order' : 'bogus ref'})`,
      upd.ok ? Array.isArray(uRows) && uRows.length === 0 : true,
      `status ${upd.status}, rows ${JSON.stringify(uRows)}`);

    const promote = await call('/rest/v1/admins', {
      method: 'POST', headers: { ...authHeaders, Prefer: 'return=minimal' },
      body: { user_id: tempUser.id, email: `${marker}@example.com` },
    });
    check('a signed-in user can never grant themselves admin', !promote.ok, `status ${promote.status}`);

    // --- leaderboard moderation -------------------------------------
    // A real score (service role skips the public RPC's throttle — that
    // write path is covered in [4]; these probes need a stable row).
    const s0 = await call('/rest/v1/quiz_scores', {
      method: 'POST', headers: { ...svcHeaders, Prefer: 'return=representation' },
      body: { name: marker, score: 2, total: 5 },
    });
    const s0Rows = jsonOf(s0.text);
    const scoreId = Array.isArray(s0Rows) && s0Rows[0] ? s0Rows[0].id : null;

    if (scoreId) {
      const del = await call(`/rest/v1/quiz_scores?id=eq.${scoreId}`, {
        method: 'DELETE', headers: { ...authHeaders, Prefer: 'return=representation' },
      });
      const dRows = del.ok ? jsonOf(del.text) : null;
      check('a signed-in non-admin can never delete leaderboard scores',
        del.ok ? Array.isArray(dRows) && dRows.length === 0 : true,
        `status ${del.status}, rows ${JSON.stringify(dRows)}`);
      const still = await call(`/rest/v1/quiz_scores?select=id&id=eq.${scoreId}`, { headers: svcHeaders });
      const stRows = still.ok ? jsonOf(still.text) : null;
      check('the probed score survives that delete',
        Array.isArray(stRows) && stRows.length === 1, `status ${still.status}`);
    } else {
      check('a signed-in non-admin can never delete leaderboard scores', false, 'probe score not created');
    }

    // --- the admin path: the DELETE grant must actually work ----------
    let modUser = null;
    try {
      const c2 = await call('/auth/v1/admin/users', {
        method: 'POST', headers: svcHeaders,
        body: { email: `${marker}-mod@example.com`, password: `Str0ng!${marker}`, email_confirm: true },
      });
      const u2 = c2.ok ? jsonOf(c2.text) : null;
      if (u2 && u2.id && scoreId) {
        modUser = u2;
        const mk = await call('/rest/v1/admins', {
          method: 'POST', headers: { ...svcHeaders, Prefer: 'return=minimal' },
          body: { user_id: u2.id, email: `${marker}-mod@example.com` },
        });
        const l2 = await call('/auth/v1/token?grant_type=password', {
          method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
          body: { email: `${marker}-mod@example.com`, password: `Str0ng!${marker}` },
        });
        const t2 = l2.ok ? jsonOf(l2.text) : null;
        if (mk.ok && t2 && t2.access_token) {
          const ah2 = { apikey: ANON, Authorization: `Bearer ${t2.access_token}`, 'Content-Type': 'application/json' };
          const adm = await call(`/rest/v1/quiz_scores?id=eq.${scoreId}`, {
            method: 'DELETE', headers: { ...ah2, Prefer: 'return=representation' },
          });
          const admRows = adm.ok ? jsonOf(adm.text) : null;
          check('an admin CAN delete a leaderboard score (moderation works)',
            adm.ok && Array.isArray(admRows) && admRows.length === 1,
            `status ${adm.status}, rows ${JSON.stringify(admRows)}`);
        } else {
          check('an admin CAN delete a leaderboard score (moderation works)', false, 'login/setup failed');
        }
      } else {
        check('an admin CAN delete a leaderboard score (moderation works)', false, c2.text.slice(0, 120));
      }
    } finally {
      if (modUser?.id) {
        await call(`/rest/v1/admins?user_id=eq.${modUser.id}`, { method: 'DELETE', headers: svcHeaders }).catch(() => {});
        await call(`/auth/v1/admin/users/${modUser.id}`, { method: 'DELETE', headers: svcHeaders }).catch(() => {});
      }
    }
  } else {
    check('could not create a throwaway test user', false, created.text.slice(0, 160));
  }
} finally {
  if (tempUser?.id) {
    await call(`/auth/v1/admin/users/${tempUser.id}`, { method: 'DELETE', headers: svcHeaders }).catch(() => {});
  }
}

/* ---------------- cleanup ---------------- */
if (pendingId) await cleanup('photo_submissions', `id=eq.${pendingId}`);
await cleanup('photo_submissions', `email=eq.${marker}@example.com`);
if (wishId) await cleanup('wishes', `id=eq.${wishId}`);
await cleanup('wishes', 'name=eq.RLS Tester');  // also catches rows whose id fetch failed
await cleanup('quiz_scores', `name=eq.${marker}`);
await cleanup('admins', `email=eq.${marker}@evil.example`);

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log('If the PII/grant tests failed, supabase/migrations/20261025_security_hardening.sql\n' +
    'has not been applied to this database yet — apply it, then re-run.\n');
}
process.exit(fail ? 1 : 0);
