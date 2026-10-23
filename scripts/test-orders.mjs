// Tests for POST /api/orders — no network, no npm deps.
// Mocks the Supabase REST calls that _lib.js makes, then asserts the
// security-critical behaviour: prices come from the DATABASE, never the client.
//
//   node scripts/test-orders.mjs

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.SHIPPING_PAISE = '7900';
// Hermetic: sourcing .env.local exports real keys into the shell, and a leaked
// STRIPE_SECRET_KEY would silently turn the "not configured" test into a live
// Stripe call. Clear them so the assertions hold regardless of the environment.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
process.env.RESEND_API_KEY = 're_test_key'; // makes sendEmail take the real path (mocked below)
process.env.ORDER_RATE_LIMIT = '0';         // hermetic: the limiter gets its own test below

const { default: handler } = await import('../api/orders.js');

// ---- fixtures ------------------------------------------------------
const PRODUCT_A = { id: 'aaaa-1111', name: 'Archive T-shirt', price_paise: 99900, active: true, stock: null };
const PRODUCT_B = { id: 'bbbb-2222', name: 'Era Poster Set', price_paise: 149900, active: true, stock: 2 };

const capturedOrders = [];
const sentEmails = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  // product lookup:  /rest/v1/merch_products?...
  if (u.includes('/rest/v1/merch_products')) {
    const ids = /id=in\.\(([^)]*)\)/.exec(u);
    const wanted = ids ? ids[1].split(',').map(decodeURIComponent) : [];
    const rows = [PRODUCT_A, PRODUCT_B].filter(p => wanted.includes(p.id));
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  // order insert:  POST /rest/v1/orders
  if (u.includes('/rest/v1/orders') && method === 'POST') {
    const body = JSON.parse(opts.body);
    capturedOrders.push(body);
    return new Response(JSON.stringify([{ ...body, id: 'order-1' }]), { status: 201 });
  }
  // order update:  PATCH /rest/v1/orders?...
  if (u.includes('/rest/v1/orders') && method === 'PATCH') {
    return new Response(JSON.stringify([]), { status: 200 });
  }
  // Resend
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

function call(body, headers = {}) {
  return new Promise(resolve => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) {
        let parsed = {};
        try { parsed = JSON.parse(chunk); } catch {}
        resolve({ status: this.statusCode, body: parsed, raw: chunk });
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
  payment_method: 'cod',
};

console.log('\napi/orders.js\n');

// 1. empty cart rejected
{
  const r = await call({ ...base, items: [] });
  check('rejects an empty cart', r.status === 400, `got ${r.status}`);
}

// 2. bad pincode rejected
{
  const r = await call({ ...base, pincode: '123', items: [{ product_id: PRODUCT_A.id, qty: 1 }] });
  check('rejects a malformed PIN code', r.status === 400, `got ${r.status}`);
}

// 3. unknown product rejected
{
  const r = await call({ ...base, items: [{ product_id: 'nope', qty: 1 }] });
  check('rejects an unknown product', r.status === 400, `got ${r.status}`);
}

// 4. stock cap enforced
{
  const r = await call({ ...base, items: [{ product_id: PRODUCT_B.id, qty: 9 }] });
  check('enforces stock limits', r.status === 400 && /Only 2/.test(r.body.error || ''), `got ${r.status} ${r.body.error}`);
}

// 5. TAMPERED PRICE: client sends price_paise: 1, DB says 99900
{
  const r = await call({
    ...base,
    items: [{ product_id: PRODUCT_A.id, qty: 2, price_paise: 1, name: 'hacked' }],
  });
  const o = capturedOrders.at(-1);
  check('client price is ignored (DB price wins)', r.status === 200 && o.subtotal_paise === 199800,
    `status ${r.status}, subtotal ${o && o.subtotal_paise}`);
  check('line item name comes from the database', o && o.items[0].name === 'Archive T-shirt');
}

// 6. free shipping over ₹1,999
{
  const r = await call({ ...base, items: [{ product_id: PRODUCT_A.id, qty: 3 }] }); // ₹2,997
  const o = capturedOrders.at(-1);
  check('shipping is free above the ₹1,999 threshold',
    r.status === 200 && o.shipping_paise === 0 && o.total_paise === o.subtotal_paise,
    `shipping ${o && o.shipping_paise}`);
}

// 7. flat shipping below threshold + correct total
{
  const r = await call({ ...base, items: [{ product_id: PRODUCT_A.id, qty: 1 }] }); // ₹999
  const o = capturedOrders.at(-1);
  check('charges flat shipping below the threshold',
    r.status === 200 && o.shipping_paise === 7900 && o.total_paise === 99900 + 7900,
    `shipping ${o && o.shipping_paise}, total ${o && o.total_paise}`);
}

// 8. reference format + owner notified on COD
{
  sentEmails.length = 0;
  const r = await call({ ...base, items: [{ product_id: PRODUCT_A.id, qty: 1 }] });
  const o = capturedOrders.at(-1);
  check('generates a PA-XXXXX reference',
    r.status === 200 && /^PA-[A-Z2-9]{5}$/.test(o.reference), `ref ${o && o.reference}`);
  check('returns the reference to the browser', r.body.reference === o.reference);
  const toList = sentEmails[0] && sentEmails[0].to;
  const toOne = Array.isArray(toList) ? toList[0] : toList;
  check('notifies the owner by email',
    sentEmails.length === 1 && toOne === 'owner@example.com',
    `sent ${sentEmails.length} to ${toOne}`);
  check('order email includes the reference and total',
    /PA-[A-Z2-9]{5}/.test(sentEmails[0]?.subject || '') && /₹/.test(sentEmails[0]?.text || ''),
    `subject ${sentEmails[0] && sentEmails[0].subject}`);
}

// 9. razorpay without keys degrades gracefully (503, not a crash)
{
  const r = await call({ ...base, payment_method: 'razorpay', items: [{ product_id: PRODUCT_A.id, qty: 1 }] });
  check('Razorpay without keys returns a friendly 503',
    r.status === 503 && /cash on delivery/i.test(r.body.error || ''), `got ${r.status}: ${r.body.error}`);
}

// 10. direct UPI (scan & pay): stored pending, buyer gets QR details
{
  sentEmails.length = 0;
  const r = await call({ ...base, payment_method: 'upi', items: [{ product_id: PRODUCT_A.id, qty: 1 }] });
  const o = capturedOrders.at(-1);
  check('UPI order is stored with payment_method upi and payment pending',
    r.status === 200 && o.payment_method === 'upi' && o.payment_status === 'pending',
    `status ${r.status}, method ${o && o.payment_method}, pay ${o && o.payment_status}`);
  check('UPI response carries reference, total and vpa for the QR panel',
    r.body.upi === true && /^PA-/.test(r.body.reference || '') &&
    r.body.total_paise === 99900 + 7900 && String(r.body.vpa || '').includes('@'),
    JSON.stringify(r.body));
  check('owner is emailed about the UPI order',
    sentEmails.some(e => /New UPI order/.test(e.subject || '')));
}

// 11. per-IP burst limit (env-tunable; <= 0 disables)
{
  process.env.ORDER_RATE_LIMIT = '3';
  let last;
  for (let i = 0; i < 4; i++) {
    last = await call(
      { ...base, items: [{ product_id: PRODUCT_A.id, qty: 1 }] },
      { 'x-forwarded-for': '203.0.113.9' });
  }
  check('4th rapid order from one IP is rate-limited with 429',
    last.status === 429, `got ${last.status}`);
  check('a different IP is unaffected',
    (await call({ ...base, items: [{ product_id: PRODUCT_A.id, qty: 1 }] },
      { 'x-forwarded-for': '198.51.100.7' })).status === 200);
  process.env.ORDER_RATE_LIMIT = '0';
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
