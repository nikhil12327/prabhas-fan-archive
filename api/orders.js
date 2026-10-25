// POST /api/orders — create a merchandise order.
// Payment methods:
//   cod      → order stored 'new' / payment 'pending'; owner is emailed.
//   stripe   → a Checkout Session is created; order stored 'pending' and
//              flipped to 'paid' by /api/stripe-webhook on success.
//   upi      → order stored 'pending'; the buyer scans the shop's UPI QR
//              and the owner confirms the payment in their UPI app.
//   razorpay → handed to /api/create-order (see below), which creates the
//              Razorpay order the browser needs to open the checkout modal.
//
// Prices are ALWAYS re-read from the database. The browser sends only
// product ids and quantities, so a tampered client cannot set its own price.

import { env, sb, sendEmail, json, makeRef, inr, rateLimit, clientIp, reserveStock, restoreStock, bodyTooLarge } from './_lib.js';

const SHIPPING_PAISE = Number(process.env.SHIPPING_PAISE ?? 7900);
const MAX_QTY = 20;
const MAX_LINES = 30;
const MAX_TOTAL_QTY = 100;
const MAX_LINE_PAISE = 2_000_000_000; // int4 ceiling in the database

function bad(res, msg) { return json(res, 400, { error: msg }); }

/** Payment could not be started: cancel the fresh order (still pending) and
 *  give the reserved stock back, so abandoned attempts never linger. */
async function abandonOrder(reference, tracked) {
  try {
    await sb.update('orders', { reference, payment_status: 'pending' }, { status: 'cancelled' });
  } catch (e) {
    console.error('[orders] cancel failed', e.message);
  }
  await restoreStock(tracked);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (bodyTooLarge(req)) return json(res, 413, { error: 'Payload too large.' });

  // Razorpay has its own route: it must create the Razorpay order first so the
  // browser can open the modal with a real order_id. A client still posting
  // the old bundle here is handed over to that handler rather than storing a
  // 'razorpay' row no payment could ever be verified against. The hand-off
  // happens before this route's own rate limit so a single request is counted
  // once, by /api/create-order alone.
  let preBody;
  try { preBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { preBody = null; }
  if (preBody && preBody.payment_method === 'razorpay') {
    const { default: createRazorpayOrder } = await import('./create-order.js');
    return createRazorpayOrder(req, res);
  }

  // Throttle before doing any work: an order row also emails the owner, so
  // an unthrottled endpoint is an email-flood and quota-burn vector.
  // ORDER_RATE_LIMIT: orders per IP per 10 minutes; <= 0 disables.
  const rl = await rateLimit('orders', clientIp(req), process.env.ORDER_RATE_LIMIT, 12);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return json(res, 429, { error: 'Too many orders from this device. Please try again in a few minutes.' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return bad(res, 'Invalid JSON'); }

  // --- validate customer fields -----------------------------------
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const line1 = String(body.address_line1 || '').trim();
  const line2 = String(body.address_line2 || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim();
  const pincode = String(body.pincode || '').trim();
  const payment = body.payment_method === 'stripe' ? 'stripe'
    : body.payment_method === 'upi' ? 'upi'
      : 'cod';

  if (!name || name.length > 80) return bad(res, 'Please enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return bad(res, 'Please enter a valid email.');
  if (!line1 || line1.length > 200) return bad(res, 'Please enter your address.');
  if (line2.length > 200) return bad(res, 'Address line 2 is too long.');
  if (!city || city.length > 80) return bad(res, 'Please enter your city.');
  if (!state || state.length > 80) return bad(res, 'Please enter your state.');
  if (!/^\d{6}$/.test(pincode)) return bad(res, 'PIN code must be 6 digits.');
  if (phone && !/^[\d\s+\-()]{6,15}$/.test(phone)) return bad(res, 'Please enter a valid phone number.');

  // --- validate cart against the database -------------------------
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return bad(res, 'Your cart is empty.');
  if (raw.length > MAX_LINES) return bad(res, 'Too many distinct items in one order.');

  const ids = [...new Set(raw.map(i => String(i.product_id)).filter(Boolean))];
  if (!ids.length) return bad(res, 'Your cart is empty.');

  let products;
  try {
    products = await sb.select('merch_products', { in_: { id: ids } });
  } catch (e) {
    console.error('[orders] product lookup failed', e);
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

  // --- atomic inventory reservation --------------------------------
  // reserve_stock() decrements in SQL with a stock >= qty predicate, so two
  // concurrent orders can never both take the last unit.
  const reserved = await reserveStock(tracked);
  if (reserved === 'insufficient') return json(res, 409, { error: 'That item just sold out. Please adjust your cart.' });
  if (reserved === 'error') return json(res, 500, { error: 'Could not reach the shop. Please try again shortly.' });

  // --- store the order (reference collision → fresh code, max 3 tries) -
  const order = {
    name, email, phone: phone || null,
    address_line1: line1, address_line2: line2 || null, city, state, pincode,
    items, subtotal_paise: subtotal, shipping_paise: shipping, total_paise: total,
    payment_method: payment, payment_status: 'pending', status: 'new',
  };

  let saved;
  for (let attempt = 0; attempt < 3; attempt++) {
    order.reference = makeRef();
    try {
      [saved] = await sb.insert('orders', order);
      break;
    } catch (e) {
      if (/duplicate key|23505/i.test(String(e.message)) && attempt < 2) continue;
      console.error('[orders] insert failed', e);
      await restoreStock(tracked);
      return json(res, 500, { error: 'Could not save your order. Please try again.' });
    }
  }
  const reference = saved.reference;

  // --- Stripe path --------------------------------------------------
  if (payment === 'stripe') {
    if (!env.stripeKey) {
      await abandonOrder(reference, tracked);
      return json(res, 503, { error: 'Online payment is not configured yet. Please choose cash on delivery.' });
    }
    try {
      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('success_url', `${env.siteUrl}/?order=${reference}&paid=1#/merch`);
      params.set('cancel_url', `${env.siteUrl}/?order=${reference}&cancelled=1#/merch`);
      params.set('customer_email', email);
      params.set('metadata[order_reference]', reference);
      items.forEach((it, i) => {
        params.set(`line_items[${i}][quantity]`, String(it.qty));
        params.set(`line_items[${i}][price_data][currency]`, 'inr');
        params.set(`line_items[${i}][price_data][unit_amount]`, String(it.price_paise));
        params.set(`line_items[${i}][price_data][product_data][name]`, it.name);
      });
      if (shipping > 0) {
        const i = items.length;
        params.set(`line_items[${i}][quantity]`, '1');
        params.set(`line_items[${i}][price_data][currency]`, 'inr');
        params.set(`line_items[${i}][price_data][unit_amount]`, String(shipping));
        params.set(`line_items[${i}][price_data][product_data][name]`, 'Shipping');
      }
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000),
      });
      const session = await r.json();
      if (!r.ok) {
        console.error('[orders] stripe error', session.error?.message);
        await abandonOrder(reference, tracked);
        return json(res, 502, { error: 'Payment could not be started. Please try again or choose cash on delivery.' });
      }
      await sb.update('orders', { reference }, { stripe_session_id: session.id });
      return json(res, 200, { ok: true, reference, url: session.url });
    } catch (e) {
      console.error('[orders] stripe exception', e);
      await abandonOrder(reference, tracked);
      return json(res, 502, { error: 'Payment could not be started. Please try again.' });
    }
  }

  // --- COD / direct-UPI path: notify the owner right away -----------
  const vpa = process.env.UPI_VPA || 'bonigalanikhil123-1@okaxis';
  const rows = items.map(i => `  ${i.qty} × ${i.name} — ${inr(i.price_paise * i.qty)}`).join('\n');
  const payLine = payment === 'upi'
    ? `Payment: UPI (scan & pay) — awaiting confirmation\nBuyer should have paid ₹${(total / 100).toFixed(2)} to ${vpa} with ${reference} in the note.`
    : 'Payment: Cash on delivery';
  const summary =
    `New order ${reference}\n\n` +
    `${name} <${email}>${phone ? ` · ${phone}` : ''}\n` +
    `${line1}${line2 ? ', ' + line2 : ''}\n${city}, ${state} ${pincode}\n\n` +
    `${rows}\n  Subtotal: ${inr(subtotal)}\n  Shipping: ${shipping ? inr(shipping) : 'Free'}\n  Total: ${inr(total)}\n\n` +
    `${payLine}\nManage: ${env.siteUrl}/admin/#/orders`;

  sendEmail({
    to: env.ownerEmail || email,
    subject: `[Fan Archive] New ${payment === 'upi' ? 'UPI ' : ''}order ${reference} — ${inr(total)}`,
    text: summary,
  }).catch(e => console.error('[orders] notify failed', e));

  // The buyer needs the reference, the exact amount and the VPA to render
  // the QR panel; payment_status stays 'pending' until the owner confirms.
  if (payment === 'upi') return json(res, 200, { ok: true, reference, total_paise: total, vpa, upi: true });

  return json(res, 200, { ok: true, reference, cod: true });
}
