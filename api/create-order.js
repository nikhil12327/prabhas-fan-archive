// POST /api/create-order — creates a Razorpay order for the checkout modal.
//
// The browser sends only product ids and quantities (plus the delivery fields
// it already collects). Prices are ALWAYS re-read from the database, so a
// tampered client cannot set its own amount. Razorpay needs the amount in
// paise, which is what we store.

import { env, sb, json, makeRef, rateLimit, clientIp, reserveStock, restoreStock, bodyTooLarge } from './_lib.js';

const SHIPPING_PAISE = Number(process.env.SHIPPING_PAISE ?? 7900);
const MAX_QTY = 20;
const MAX_LINES = 30;
const MAX_TOTAL_QTY = 100;
const MAX_LINE_PAISE = 2_000_000_000; // int4 ceiling in the database

function bad(res, msg) { return json(res, 400, { error: msg }); }

/** Razorpay order could not be created: cancel the fresh order and give the
 *  reserved stock back so abandoned attempts never linger. */
async function abandonOrder(reference, tracked) {
  try {
    await sb.update('orders', { reference, payment_status: 'pending' }, { status: 'cancelled' });
  } catch (e) {
    console.error('[create-order] cancel failed', e.message);
  }
  await restoreStock(tracked);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (bodyTooLarge(req)) return json(res, 413, { error: 'Payload too large.' });

  if (!env.razorpayKeyId || !env.razorpaySecret) {
    return json(res, 503, { error: 'Online payment is not configured yet. Please choose cash on delivery.' });
  }

  // Throttle before doing any work: an order row also emails the owner, so
  // an unthrottled endpoint is an email-flood and quota-burn vector.
  const rl = await rateLimit('orders', clientIp(req), process.env.ORDER_RATE_LIMIT, 12);
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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return bad(res, 'Please enter a valid email.');
  if (!line1 || line1.length > 200) return bad(res, 'Please enter your address.');
  if (line2.length > 200) return bad(res, 'Address line 2 is too long.');
  if (!city || city.length > 80) return bad(res, 'Please enter your city.');
  if (!state || state.length > 80) return bad(res, 'Please enter your state.');
  if (!/^\d{6}$/.test(pincode)) return bad(res, 'PIN code must be 6 digits.');
  if (phone && !/^[\d\s+\-()]{6,15}$/.test(phone)) return bad(res, 'Please enter a valid phone number.');

  // --- validate cart against the database ----------------------------
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return bad(res, 'Your cart is empty.');
  if (raw.length > MAX_LINES) return bad(res, 'Too many distinct items in one order.');

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
  const tracked = []; // [{id, qty}] for products with a stock counter
  let subtotal = 0;
  let totalQty = 0;

  for (const line of raw) {
    const p = byId.get(String(line.product_id));
    if (!p) return bad(res, 'One of the items in your cart is no longer available.');
    const qty = Math.floor(Number(line.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) return bad(res, `Quantity for ${p.name} is invalid.`);
    if (p.stock != null && qty > p.stock) return bad(res, `Only ${p.stock} of ${p.name} left in stock.`);
    totalQty += qty;
    if (totalQty > MAX_TOTAL_QTY) return bad(res, 'That is too many items in one order.');
    subtotal += p.price_paise * qty;
    items.push({ product_id: p.id, name: p.name, price_paise: p.price_paise, qty });
    if (p.stock != null) tracked.push({ id: p.id, qty });
  }
  if (!Number.isSafeInteger(subtotal) || subtotal > MAX_LINE_PAISE) {
    return bad(res, 'That order total is too large.');
  }

  const shipping = subtotal >= 199900 ? 0 : SHIPPING_PAISE; // free over ₹1,999
  const total = subtotal + shipping;
  if (total < 100) return bad(res, 'Order total is below the minimum payable amount.'); // Razorpay minimum

  // --- atomic inventory reservation (two orders cannot take the last unit)
  const reserved = await reserveStock(tracked);
  if (reserved === 'insufficient') return json(res, 409, { error: 'That item just sold out. Please adjust your cart.' });
  if (reserved === 'error') return json(res, 500, { error: 'Could not reach the shop. Please try again shortly.' });

  // --- store the order (payment_status stays 'pending') --------------
  const order = {
    name, email, phone: phone || null,
    address_line1: line1, address_line2: line2 || null, city, state, pincode,
    items, subtotal_paise: subtotal, shipping_paise: shipping, total_paise: total,
    payment_method: 'razorpay', payment_status: 'pending', status: 'new',
  };

  let saved;
  for (let attempt = 0; attempt < 3; attempt++) {
    order.reference = makeRef();
    try {
      [saved] = await sb.insert('orders', order);
      break;
    } catch (e) {
      if (/duplicate key|23505/i.test(String(e.message)) && attempt < 2) continue;
      console.error('[create-order] insert failed', e);
      await restoreStock(tracked);
      return json(res, 500, { error: 'Could not save your order. Please try again.' });
    }
  }
  const reference = saved.reference;

  // --- create the Razorpay order -------------------------------------
  try {
    const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpaySecret}`).toString('base64');      const r = await fetch('https://api.razorpay.com/v1/orders', {
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
        signal: AbortSignal.timeout(10000),
      });
    const rzp = await r.json();
    if (!r.ok) {
      console.error('[create-order] razorpay error', rzp.error?.description || r.status);
      await abandonOrder(reference, tracked);
      return json(res, 502, { error: 'Payment could not be started. Please try again or choose cash on delivery.' });
    }
    // Store the Razorpay order id in its OWN column (never stripe_session_id):
    // verify-payment and the webhook bind payments to the order through it.
    await sb.update('orders', { reference }, { razorpay_order_id: rzp.id });
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
    await abandonOrder(reference, tracked);
    return json(res, 502, { error: 'Payment could not be started. Please try again.' });
  }
}
