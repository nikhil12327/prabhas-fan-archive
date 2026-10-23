// Tests for /api/create-order and /api/verify-payment — no network, no npm deps.
// Mocks Supabase REST and Razorpay's order API, then asserts the
// security-critical behaviour: prices come from the DATABASE, the amount is in
// paise, and a forged signature never marks an order paid.
//
//   node scripts/test-razorpay.mjs

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.SHIPPING_PAISE = '7900';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'razorpay-secret-test';
process.env.RESEND_API_KEY = 're_test_key';
process.env.ORDER_RATE_LIMIT = '0'; // hermetic

import crypto from 'node:crypto';

const { default: createOrder } = await import('../api/create-order.js');
const { default: verifyPayment } = await import('../api/verify-payment.js');

const PRODUCT_A = { id: 'aaaa-1111', name: 'Archive T-shirt', price_paise: 99900, active: true, stock: null };

const capturedOrders = [];
const razorpayCalls = [];
const orderUpdates = [];
const sentEmails = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  if (u.includes('/rest/v1/merch_products')) {
    const at = u.indexOf('id=in.(');
    const wanted = at < 0 ? [] : u.slice(at + 7, u.indexOf(')', at)).split(',').map(decodeURIComponent);
    const rows = [PRODUCT_A].filter(p => wanted.includes(p.id));
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (u.includes('/rest/v1/orders') && method === 'POST') {
    const body = JSON.parse(opts.body);
    capturedOrders.push(body);
    return new Response(JSON.stringify([{ ...body, id: 'order-1' }]), { status: 201 });
  }
  if (u.includes('/rest/v1/orders') && method === 'GET') {
    const m = /reference=eq\.([^&]+)/.exec(u);
    const reference = m ? decodeURIComponent(m[1]) : '';
    const stored = capturedOrders.find(o => o.reference === reference);
    const row = stored || {
      reference, name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210',
      address_line1: '12 Temple Street', address_line2: null, city: 'Hyderabad',
      state: 'Telangana', pincode: '500001',
      items: [{ product_id: PRODUCT_A.id, name: PRODUCT_A.name, price_paise: PRODUCT_A.price_paise, qty: 1 }],
      subtotal_paise: PRODUCT_A.price_paise, shipping_paise: 7900,
      total_paise: PRODUCT_A.price_paise + 7900,
      payment_method: 'razorpay', payment_status: 'pending', status: 'new',
    };
    return new Response(JSON.stringify([row]), { status: 200 });
  }
  if (u.includes('/rest/v1/orders') && method === 'PATCH') {
    const match = Object.fromEntries(
      new URL(u).searchParams.toString().split('&').map(kv => kv.split('=').map(decodeURIComponent))
    );
    const patch = JSON.parse(opts.body);
    orderUpdates.push({ match, patch });
    return new Response(JSON.stringify([{ ...patch }]), { status: 200 });
  }
  if (u.includes('api.razorpay.com/v1/orders')) {
    razorpayCalls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'order_rzp_1', amount: JSON.parse(opts.body).amount, currency: 'INR' }), { status: 200 });
  }
  if (u.includes('api.resend.com')) {
    sentEmails.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function call(handler, body, headers = {}) {
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
    handler({ method: 'POST', body: JSON.stringify(body), headers }, res);
  });
}

const base = {
  name: 'Asha Rao',
  email: 'asha@example.com',
  phone: '9876543210',
  address_line1: '12 Temple Street',
  city: 'Hyderabad',
  state: 'Telangana',
  pincode: '500001',
};

console.log('\\napi/create-order.js\\n');

// 1. creates a razorpay order and returns key data
{
  const r = await call(createOrder, { ...base, items: [{ product_id: PRODUCT_A.id, qty: 1 }] });
  check('creates a Razorpay order with amount in paise',
    r.status === 200 && r.body.razorpay_order_id === 'order_rzp_1' &&
    r.body.amount === 99900 + 7900 && r.body.currency === 'INR' && r.body.key_id === 'rzp_test_key',
    JSON.stringify(r.body));
  check('sends the amount in paise to Razorpay', (razorpayCalls.at(-1) || {}).amount === 99900 + 7900,
    JSON.stringify(razorpayCalls.at(-1)));
  check('stores the order with payment_method razorpay', capturedOrders.at(-1).payment_method === 'razorpay');
  check('stored order is pending until verified',
    capturedOrders.at(-1).payment_status === 'pending' && capturedOrders.at(-1).status === 'new');
}

// 2. TAMPERED PRICE ignored
{
  const r = await call(createOrder, {
    ...base,
    items: [{ product_id: PRODUCT_A.id, qty: 2, price_paise: 1, name: 'hacked' }],
  });
  const o = capturedOrders.at(-1);
  check('client price is ignored (DB price wins)', r.status === 200 && o.subtotal_paise === 199800,
    `status ${r.status}, subtotal ${o && o.subtotal_paise}`);
}

console.log('\\napi/verify-payment.js\\n');

// 3. missing fields rejected
{
  const r = await call(verifyPayment, { reference: 'PA-TEST2' });
  check('rejects missing payment fields', r.status === 400, `got ${r.status}`);
}

// 4. forged signature rejected, order not marked paid
{
  orderUpdates.length = 0; sentEmails.length = 0;
  const r = await call(verifyPayment, {
    razorpay_order_id: 'order_rzp_1',
    razorpay_payment_id: 'pay_1',
    razorpay_signature: 'deadbeef',
    reference: 'PA-TEST2',
  });
  check('rejects an invalid signature with 400', r.status === 400, `got ${r.status}`);
  check('a forged signature writes nothing', orderUpdates.length === 0);
  check('a forged signature sends no emails', sentEmails.length === 0);
}

// 5. valid signature marks the order paid
{
  orderUpdates.length = 0; sentEmails.length = 0;
  const sig = crypto.createHmac('sha256', 'razorpay-secret-test')
    .update('order_rzp_1|pay_1').digest('hex');
  const r = await call(verifyPayment, {
    razorpay_order_id: 'order_rzp_1',
    razorpay_payment_id: 'pay_1',
    razorpay_signature: sig,
    reference: 'PA-TEST2',
  });
  const p = orderUpdates[0] && orderUpdates[0].patch;
  check('valid signature marks the order paid', r.status === 200 && p.payment_status === 'paid',
    `status ${r.status}, patches ${JSON.stringify(orderUpdates.map(u => u.patch))}`);
  check('sets the order status to confirmed', p && p.status === 'confirmed');
  check('sends a receipt to the buyer', sentEmails.some(e => (Array.isArray(e.to) ? e.to[0] : e.to) === 'asha@example.com'));
}

globalThis.fetch = realFetch;

console.log(`\\n${pass} passed, ${fail} failed\\n`);
process.exit(fail ? 1 : 0);
