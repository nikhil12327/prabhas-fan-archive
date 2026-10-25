// Tests for POST /api/stripe-webhook — no network, no npm deps.
// Signs payloads exactly as Stripe does (HMAC over "t.payload") so the real
// signature check runs, then asserts the UPI-specific routing:
//
//   UPI settles ASYNCHRONOUSLY. Stripe sends checkout.session.completed with
//   payment_status 'unpaid' first, then async_payment_succeeded / _failed
//   later. An order must only flip to 'paid' once the money has landed.
//
//   node scripts/test-webhook.mjs

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const SECRET = 'whsec_test_secret';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.RESEND_API_KEY = 're_test_key';

const { default: handler } = await import('../api/stripe-webhook.js');

// ---- fixtures ------------------------------------------------------
const ORDER = {
  reference: 'PA-TEST2', name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210',
  address_line1: '12 Temple Street', address_line2: null, city: 'Hyderabad',
  state: 'Telangana', pincode: '500001',
  items: [{ product_id: 'aaaa-1111', name: 'Archive T-shirt', price_paise: 99900, qty: 1 }],
  subtotal_paise: 99900, shipping_paise: 7900, total_paise: 107800,
  payment_method: 'stripe', payment_status: 'pending', status: 'new',
};

const updates = [];   // { match, patch } for every PATCH to /rest/v1/orders
const sentEmails = [];
let currentOrder = { ...ORDER }; // mutable: CAS tests flip payment_status

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  // SELECT by reference (the handler binds the event to our stored row first)
  if (u.includes('/rest/v1/orders') && method === 'GET') {
    return new Response(JSON.stringify(currentOrder ? [currentOrder] : []), { status: 200 });
  }
  if (u.includes('/rest/v1/orders') && method === 'PATCH') {
    // PostgREST match values carry the operator prefix (eq.X) — strip it so
    // the simulated CAS compares real column values.
    const match = Object.fromEntries(
      new URL(u).searchParams.toString().split('&').map(kv => {
        const [k, v] = kv.split('=').map(decodeURIComponent);
        return [k, String(v).startsWith('eq.') ? String(v).slice(3) : v];
      })
    );
    const patch = JSON.parse(opts.body);
    // Simulate PostgREST's conditional UPDATE: the patch lands only when
    // every match column equals the stored value (this is what makes the
    // pending -> paid transition atomic).
    const rows = currentOrder && Object.entries(match).every(([k, v]) => currentOrder[k] === v);
    if (!rows) return new Response(JSON.stringify([]), { status: 200 });
    updates.push({ match, patch });
    currentOrder = { ...currentOrder, ...patch };
    return new Response(JSON.stringify([{ ...currentOrder }]), { status: 200 });
  }
  if (u.includes('api.resend.com')) {
    sentEmails.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

// ---- tiny test runner ----------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Build a Stripe-style `t=...,v1=...` header over the payload. */
function sign(payload, ts = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

/** POST an event through the real handler with a real signature.
 *  `ts` backdates the signature to exercise the replay window. */
function send(event, { header, ts } = {}) {
  const payload = JSON.stringify(event);
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = {
    'stripe-signature': header !== undefined ? header : sign(payload, ts || Math.floor(Date.now() / 1000)),
  };
  req.method = 'POST';

  return new Promise(resolve => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) {
        let parsed = {};
        try { parsed = JSON.parse(chunk); } catch {}
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    handler(req, res);
  });
}

const ev = (type, { payment_status, reference = 'PA-TEST2', id = 'cs_test_1' } = {}) => ({
  type,
  data: { object: { id, payment_status, metadata: { order_reference: reference } } },
});

function reset() {
  updates.length = 0;
  sentEmails.length = 0;
  currentOrder = { ...ORDER };
}

console.log('\napi/stripe-webhook.js\n');

// 1. forged / unsigned payload is rejected outright
reset();
{
  const r = await send(ev('checkout.session.completed', { payment_status: 'paid' }), { header: 't=1,v1=deadbeef' });
  check('rejects an invalid signature', r.status === 400, `got ${r.status}`);
  check('a forged signature writes nothing', updates.length === 0);
}

// 2. UPI: completed + unpaid must NOT fulfil (the core async rule)
reset();
{
  const r = await send(ev('checkout.session.completed', { payment_status: 'unpaid' }));
  check('UPI checkout.session.completed is acknowledged', r.status === 200, `got ${r.status}`);
  check('does NOT mark an unpaid UPI order paid', updates.length === 0,
    `saw ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sends no receipt before the money lands', sentEmails.length === 0);
}

// 3. card: completed + paid DOES fulfil
reset();
{
  const r = await send(ev('checkout.session.completed', { payment_status: 'paid' }));
  const p = updates[0] && updates[0].patch;
  check('marks a settled card order paid', updates.length === 1 && p.payment_status === 'paid',
    `updates ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sets the order status to confirmed', p && p.status === 'confirmed');
  check('sends a receipt to the buyer', sentEmails.some(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'asha@example.com'));
}

// 4. UPI async success — the event that actually confirms the money
reset();
{
  const r = await send(ev('checkout.session.async_payment_succeeded', { payment_status: 'paid' }));
  const p = updates[0] && updates[0].patch;
  check('async_payment_succeeded marks the order paid',
    r.status === 200 && updates.length === 1 && p.payment_status === 'paid' && p.status === 'confirmed',
    `status ${r.status}, patches ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sends the buyer a receipt on async success',
    sentEmails.some(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'asha@example.com'));
}

// 5. UPI async failure — must record 'failed', not 'paid'
reset();
{
  const r = await send(ev('checkout.session.async_payment_failed', { payment_status: 'unpaid' }));
  const p = updates[0] && updates[0].patch;
  check('async_payment_failed marks the order failed',
    r.status === 200 && updates.length === 1 && p.payment_status === 'failed',
    `status ${r.status}, patches ${JSON.stringify(updates.map(u => u.patch))}`);
  check('a failed UPI payment is never marked paid',
    updates.every(u => u.patch.payment_status !== 'paid'));
  check('sends no receipt for a failed payment', sentEmails.length === 0);
}

// 6. expired session — buyer walked away, order stays pending
reset();
{
  const r = await send(ev('checkout.session.expired', { payment_status: 'unpaid' }));
  check('expired session is acknowledged', r.status === 200, `got ${r.status}`);
  check('an expired session writes nothing (order stays pending)', updates.length === 0,
    `saw ${JSON.stringify(updates.map(u => u.patch))}`);
}

// 7. unrelated event types are ignored
reset();
{
  const r = await send({ type: 'invoice.payment_succeeded', data: { object: {} } });
  check('unrelated events are ignored with 200', r.status === 200 && updates.length === 0,
    `status ${r.status}, updates ${updates.length}`);
}

// 8. event without an order_reference is ignored, not crashed on
reset();
{
  const r = await send({ type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', metadata: {} } } });
  check('a session without order_reference is tolerated', r.status === 200 && updates.length === 0,
    `status ${r.status}, updates ${updates.length}`);
}

// 9. REPLAY WINDOW: a captured signature older than the tolerance is refused
reset();
{
  const staleTs = Math.floor(Date.now() / 1000) - 3600;
  const r = await send(ev('checkout.session.completed', { payment_status: 'paid' }),
    { ts: staleTs });
  check('a replayed signature outside the tolerance window is rejected',
    r.status === 400 && updates.length === 0,
    `status ${r.status}, updates ${updates.length}`);
}

// 10. SESSION BINDING: an event for a different session never touches the order
reset();
{
  currentOrder = { ...ORDER, stripe_session_id: 'cs_expected_1' };
  const r = await send(ev('checkout.session.completed', { payment_status: 'paid', id: 'cs_attacker_9' }));
  check('a mismatched Stripe session is acknowledged but ignored',
    r.status === 200 && updates.length === 0,
    `status ${r.status}, updates ${JSON.stringify(updates.map(u => u.patch))}`);
  check('a mismatched session sends no email', sentEmails.length === 0);
}

// 11. DOUBLE DELIVERY: Stripe retries; the second identical event must not
//     fulfil or email again (the conditional update finds 0 rows).
reset();
{
  const first = await send(ev('checkout.session.completed', { payment_status: 'paid' }));
  const second = await send(ev('checkout.session.completed', { payment_status: 'paid' }));
  const paidPatches = updates.filter(u => u.patch.payment_status === 'paid');
  check('the first delivery fulfils once', paidPatches.length === 1,
    `patches ${JSON.stringify(updates.map(u => u.patch))}`);
  check('a replayed delivery finds nothing to do',
    first.status === 200 && second.status === 200 && paidPatches.length === 1);
  check('the buyer is emailed exactly once',
    sentEmails.filter(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'asha@example.com').length === 1);
}

// 12. AMOUNT BINDING: a session whose total differs from the order is ignored
reset();
{
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', currency: 'inr',
      amount_total: 100, metadata: { order_reference: 'PA-TEST2' } } },
  });
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = { 'stripe-signature': (() => {
    const ts = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex');
    return `t=${ts},v1=${v1}`;
  })() };
  req.method = 'POST';
  const status = await new Promise(resolve => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      end() { resolve(this.statusCode); } };
    handler(req, res);
  });
  check('a mismatched amount total never fulfils', status === 200 && updates.length === 0,
    `status ${status}, updates ${updates.length}`);
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
