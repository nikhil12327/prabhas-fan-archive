// Tests for POST /api/razorpay-webhook — no network, no npm deps.
// Signs payloads exactly as Razorpay does (HMAC-SHA256 over the raw body) so
// the real signature check runs, then asserts the fulfilment rules:
//
//   The webhook is the SAFETY NET behind /api/verify-payment. If the buyer
//   closes the tab after paying, `payment.captured` still arrives server-to-
//   server and the order is fulfilled. It must be IDEMPOTENT (Razorpay
//   retries, and the browser may have already flipped the row) and must never
//   fulfil on a mismatched amount.
//
//   node scripts/test-razorpay-webhook.mjs

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const SECRET = 'whsec_rzp_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.RESEND_API_KEY = 're_test_key';

const { default: handler } = await import('../api/razorpay-webhook.js');

// ---- fixtures ------------------------------------------------------
const ORDER = {
  reference: 'PA-TEST1', name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210',
  address_line1: '12 Temple Street', address_line2: null, city: 'Hyderabad',
  state: 'Telangana', pincode: '500001',
  items: [{ product_id: 'aaaa-1111', name: 'Archive T-shirt', price_paise: 99900, qty: 1 }],
  subtotal_paise: 99900, shipping_paise: 7900, total_paise: 107800,
  payment_method: 'razorpay', payment_status: 'pending', status: 'new',
  razorpay_order_id: 'order_rzp_1',   // provider-specific column (never stripe_session_id)
};

const updates = [];   // { match, patch } for every PATCH to /rest/v1/orders
const sentEmails = [];
let currentOrder = { ...ORDER }; // mutable so tests can pre-set payment_status

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  // Lookups by stripe_session_id come back as a select on /rest/v1/orders.
  if (u.includes('/rest/v1/orders') && method === 'GET') {
    return new Response(JSON.stringify([currentOrder]), { status: 200 });
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
    // Simulate PostgREST's conditional UPDATE: zero rows unless every match
    // column equals the stored value (pending -> paid exactly once).
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

/** Razorpay signs the raw body itself: HMAC-SHA256(body, secret).hex */
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

/** POST an event through the real handler with a real signature. */
function send(event, { signature } = {}) {
  const payload = JSON.stringify(event);
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = { 'x-razorpay-signature': signature === undefined ? sign(payload) : signature };
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

/** A Razorpay payment.captured / payment.failed event. */
function ev(kind, { amount = 107800, order_id = 'order_rzp_1', id = 'pay_rzp_1' } = {}) {
  return {
    type: kind,
    payload: { payment: { entity: { id, order_id, amount, currency: 'INR' } } },
  };
}

function reset(orderPatch = {}) {
  updates.length = 0;
  sentEmails.length = 0;
  currentOrder = { ...ORDER, ...orderPatch };
}

console.log('\napi/razorpay-webhook.js\n');

// 1. forged / unsigned payload is rejected outright
reset();
{
  const r = await send(ev('payment.captured'), { signature: 'deadbeef' });
  check('rejects an invalid signature', r.status === 400, `got ${r.status}`);
  check('a forged signature writes nothing', updates.length === 0,
    `saw ${JSON.stringify(updates.map(u => u.patch))}`);
  check('a forged signature sends no email', sentEmails.length === 0);
}

// 2. the happy path: captured + matching amount fulfils
reset();
{
  const r = await send(ev('payment.captured'));
  const p = updates[0] && updates[0].patch;
  check('payment.captured marks the order paid',
    r.status === 200 && updates.length === 1 && p.payment_status === 'paid',
    `status ${r.status}, patches ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sets the order status to confirmed', p && p.status === 'confirmed');
  check('stores the razorpay order id in its own column',
    p && p.razorpay_order_id === 'order_rzp_1' && !('stripe_session_id' in (p || {})) || false,
    JSON.stringify(p));
  check('sends a receipt to the buyer',
    sentEmails.some(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'asha@example.com'));
  check('alerts the owner',
    sentEmails.some(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'owner@example.com'));
  check('receipt mentions the razorpay payment id',
    sentEmails.some(e => String(e.text).includes('pay_rzp_1')));
}

// 3. IDEMPOTENT: an already-paid order is not fulfilled or emailed again.
//    Razorpay retries webhooks, and /api/verify-payment may have won the race.
reset({ payment_status: 'paid', status: 'confirmed' });
{
  const r = await send(ev('payment.captured'));
  check('an already-paid order is acknowledged', r.status === 200, `got ${r.status}`);
  check('does not write a second time', updates.length === 0,
    `saw ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sends no duplicate receipt', sentEmails.length === 0,
    `sent ${sentEmails.length}`);
}

// 4. AMOUNT MISMATCH must never fulfil (tampered or partial payment)
reset();
{
  const r = await send(ev('payment.captured', { amount: 100 }));
  check('a mismatched amount is acknowledged', r.status === 200, `got ${r.status}`);
  check('does NOT fulfil on an amount mismatch', updates.length === 0,
    `saw ${JSON.stringify(updates.map(u => u.patch))}`);
  check('sends no receipt on an amount mismatch', sentEmails.length === 0);
}

// 5. payment.failed records the failure, and never downgrades a paid order
reset();
{
  const r = await send(ev('payment.failed'));
  const p = updates[0] && updates[0].patch;
  check('payment.failed marks the order failed',
    r.status === 200 && updates.length === 1 && p.payment_status === 'failed',
    `status ${r.status}, patches ${JSON.stringify(updates.map(u => u.patch))}`);
  check('a failed payment is never marked paid',
    updates.every(u => u.patch.payment_status !== 'paid'));
  check('sends no receipt for a failed payment', sentEmails.length === 0);
}
reset({ payment_status: 'paid', status: 'confirmed' });
{
  const r = await send(ev('payment.failed'));
  check('a failed event does NOT downgrade an already-paid order',
    r.status === 200 && updates.length === 0,
    `status ${r.status}, patches ${JSON.stringify(updates.map(u => u.patch))}`);
}

// 6. an order we do not own is acknowledged, not crashed on, not retried
reset();
{
  currentOrder = null;
  const r = await send(ev('payment.captured', { order_id: 'order_someone_elses' }));
  check('an unknown order is acknowledged with 200', r.status === 200, `got ${r.status}`);
  check('an unknown order writes nothing', updates.length === 0);
}

// 7. event with no payment entity is ignored
reset();
{
  const r = await send({ type: 'payment.captured', payload: {} });
  check('an event without a payment entity is tolerated', r.status === 200 && updates.length === 0,
    `status ${r.status}, updates ${updates.length}`);
}

// 8. unrelated event types are ignored
reset();
{
  const r = await send({ type: 'refund.processed', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_rzp_1', amount: 107800 } } } });
  check('unrelated events are ignored with 200', r.status === 200 && updates.length === 0,
    `status ${r.status}, updates ${updates.length}`);
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
