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
  reference: 'PA-TEST1', name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210',
  address_line1: '12 Temple Street', address_line2: null, city: 'Hyderabad',
  state: 'Telangana', pincode: '500001',
  items: [{ product_id: 'aaaa-1111', name: 'Archive T-shirt', price_paise: 99900, qty: 1 }],
  subtotal_paise: 99900, shipping_paise: 7900, total_paise: 107800,
  payment_method: 'stripe', payment_status: 'pending', status: 'new',
};

const updates = [];   // { match, patch } for every PATCH to /rest/v1/orders
const sentEmails = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  if (u.includes('/rest/v1/orders') && method === 'PATCH') {
    const match = Object.fromEntries(
      new URL(u).searchParams.toString().split('&').map(kv => kv.split('=').map(decodeURIComponent))
    );
    const patch = JSON.parse(opts.body);
    updates.push({ match, patch });
    return new Response(JSON.stringify([{ ...ORDER, ...patch }]), { status: 200 });
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

/** POST an event through the real handler with a real signature. */
function send(event, { header } = {}) {
  const payload = JSON.stringify(event);
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = { 'stripe-signature': header === undefined ? sign(payload) : header };
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

const ev = (type, { payment_status, reference = 'PA-TEST1', id = 'cs_test_1' } = {}) => ({
  type,
  data: { object: { id, payment_status, metadata: { order_reference: reference } } },
});

function reset() { updates.length = 0; sentEmails.length = 0; }

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

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
