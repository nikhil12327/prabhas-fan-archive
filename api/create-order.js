// POST /api/create-order — creates a Razorpay order for the checkout modal.
//
// The browser sends only product ids and quantities (plus the delivery fields
// it already collects). Prices are ALWAYS re-read from the database, so a
// tampered client cannot set its own amount. Razorpay needs the amount in
// paise, which is what we store.

import { env, sb, json, makeRef, rateLimit, clientIp } from './_lib.js';

const SHIPPING_PAISE = Number(process.env.SHIPPING_PAISE ?? 7900);
const MAX_QTY = 20;

function bad(res, msg) { return json(res, 400, { error: msg }); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!env.razorpayKeyId || !env.razorpaySecret) {
    return json(res, 503, { error: 'Online payment is not configured yet. Please choose cash on delivery.' });
  }

  // Throttle before doing any work: an order row also emails the owner, so
  // an unthrottled endpoint is an email-flood and quota-burn vector.
  const rl = rateLimit('orders', clientIp(req), Number(process.env.ORDER_RATE_LIMIT ?? 12));
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return json(res, 429, { error: 'Too many orders from this device. Please try again in a few minutes.' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return bad(res, 'Invalid JSON'); }

  // --- validate customer fields (same rules as /api/orders) ----------
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const line1 = String(body.address_line1 || '').trim();
  const line2 = String(body.address_line2 || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim();
  const pincode = String(body.pincode || '').trim();

  if (!name || name.length > 80) return bad(res, 'Please enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Please enter a valid email.');
  if (!line1 || line1.length > 200) return bad(res, 'Please enter your address.');
  if (!city || !state) return bad(res, 'Please enter your city and state.');
  if (!/^\d{6}$/.test(pincode)) return bad(res, 'PIN code must be 6 digits.');
  if (phone && !/^[\d\s+\-()]{6,15}$/.test(phone)) return bad(res, 'Please enter a valid phone number.');

  // --- validate cart against the database ----------------------------
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return bad(res, 'Your cart is empty.');
  if (raw.length > 30) return bad(res, 'Too many distinct items in one order.');

  const ids = [...new Set(raw.map(i => String(i.product_id)).filter(Boolean))];
  if (!ids.length) return bad(res, 'Your cart is empty.');

  let products;
  try {
    products = await sb.select('merch_products', { in_: { id: ids } });
  } catch (e) {
    console.error('[create-order] product lookup failed', e);
    return json(res, 500, { error: 'Could not reach the shop. Please try again shortly.' });
  }

  const byId = new Map(products.filter(p => p.active).map(p => [p.id, p]));
  const items = [];
  let subtotal = 0;

  for (const line of raw) {
    const p = byId.get(String(line.product_id));
    if (!p) return bad(res, 'One of the items in your cart is no longer available.');
    const qty = Math.floor(Number(line.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) return bad(res, `Quantity for ${p.name} is invalid.`);
    if (p.stock != null && qty > p.stock) return bad(res, `Only ${p.stock} of ${p.name} left in stock.`);
    subtotal += p.price_paise * qty;
    items.push({ product_id: p.id, name: p.name, price_paise: p.price_paise, qty });
  }

  const shipping = subtotal >= 199900 ? 0 : SHIPPING_PAISE; // free over ₹1,999
  const total = subtotal + shipping;
  if (total < 100) return bad(res, 'Order total is below the minimum payable amount.'); // Razorpay minimum

  const reference = makeRef();

  // --- store the order (payment_status stays 'pending') --------------
  const order = {
    reference, name, email, phone: phone || null,
    address_line1: line1, address_line2: line2 || null, city, state, pincode,
    items, subtotal_paise: subtotal, shipping_paise: shipping, total_paise: total,
    payment_method: 'razorpay', payment_status: 'pending', status: 'new',
  };

  let saved;
  try {
    [saved] = await sb.insert('orders', order);
  } catch (e) {
    console.error('[create-order] insert failed', e);
    return json(res, 500, { error: 'Could not save your order. Please try again.' });
  }

  // --- create the Razorpay order -------------------------------------
  try {
    const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpaySecret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: total,          // paise
        currency: 'INR',
        receipt: reference,
        notes: { order_reference: reference },
      }),
    });
    const rzp = await r.json();
    if (!r.ok) {
      console.error('[create-order] razorpay error', rzp.error?.description || r.status);
      return json(res, 502, { error: 'Payment could not be started. Please try again or choose cash on delivery.' });
    }
    await sb.update('orders', { reference }, { stripe_session_id: rzp.id }); // reuse existing column as razorpay order id
    return json(res, 200, {
      ok: true,
      reference,
      razorpay_order_id: rzp.id,
      amount: rzp.amount,
      currency: rzp.currency,
      key_id: env.razorpayKeyId,   // safe to expose; the secret never leaves the server
    });
  } catch (e) {
    console.error('[create-order] razorpay exception', e);
    return json(res, 502, { error: 'Payment could not be started. Please try again.' });
  }
}
