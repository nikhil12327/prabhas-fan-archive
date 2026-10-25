// POST /api/verify-payment — verifies a Razorpay checkout signature AND the
// payment itself, then flips the order to 'paid'.
//
// Defence layers, in order:
//   1. HMAC-SHA256(order_id + "|" + payment_id) recomputed with the
//      KEY_SECRET and compared in constant time.
//   2. The order MUST already store this exact Razorpay order id
//      (`razorpay_order_id`) — a signature minted for a different, cheaper
//      order can never confirm this one. A missing stored id is a rejection,
//      not a pass.
//   3. The payment is fetched server-side from Razorpay and must be
//      captured, INR, for the full expected amount and on the expected
//      order. A browser-supplied signature alone never proves the money
//      landed.
//   4. The paid transition is a conditional UPDATE (payment_status must
//      still be 'pending'), so concurrent calls/webhooks fulfil once and
//      email once.
//
// /api/razorpay-webhook remains the authoritative safety net: if this
// handler cannot reach Razorpay, we tell the buyer the confirmation is
// coming and the webhook fulfils the order server-to-server.

import crypto from 'node:crypto';
import { env, sb, sendEmail, json, inr, rateLimit, clientIp, bodyTooLarge } from './_lib.js';

function bad(res, msg) { return json(res, 400, { error: msg }); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (bodyTooLarge(req)) return json(res, 413, { error: 'Payload too large.' });

  if (!env.razorpaySecret) {
    console.error('[verify] RAZORPAY_KEY_SECRET is not set');
    return json(res, 503, { error: 'Online payment is not configured yet.' });
  }

  // Verification flips payment state and sends mail — throttle it like the
  // order endpoints. Clamped: a bad env value can never disable it.
  const rl = await rateLimit('verify', clientIp(req), process.env.VERIFY_RATE_LIMIT, 30);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return json(res, 429, { error: 'Too many verification attempts. Please wait a minute and try again.' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return bad(res, 'Invalid JSON'); }

  const orderId = String(body.razorpay_order_id || '');
  const paymentId = String(body.razorpay_payment_id || '');
  const signature = String(body.razorpay_signature || '');
  const reference = String(body.reference || '').trim();

  if (!orderId || !paymentId || !signature) return bad(res, 'Missing payment fields.');
  if (!/^PA-[A-Z2-9]{5}$/.test(reference)) return bad(res, 'Invalid order reference.');
  // Razorpay ids: order_... / pay_... — reject junk before any lookup.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId) || !/^[A-Za-z0-9_-]{1,64}$/.test(paymentId)) {
    return bad(res, 'Invalid payment identifiers.');
  }

  // --- 1. constant-time signature check ------------------------------
  const expected = crypto
    .createHmac('sha256', env.razorpaySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error('[verify] signature mismatch for', reference);
    return json(res, 400, { error: 'Payment signature does not match. Your order was not marked as paid.' });
  }

  // --- 2. look up the order and bind it to THIS razorpay order --------
  let rows;
  try { rows = await sb.select('orders', { eq: { reference } }); }
  catch (e) { console.error('[verify] lookup failed', e); return json(res, 500, { error: 'Could not confirm the order.' }); }

  const order = rows[0];
  if (!order) return bad(res, 'Order not found.');
  if (!order.razorpay_order_id) {
    console.error('[verify] no stored razorpay order id for', reference);
    return bad(res, 'This order is not linked to that payment. Your order was not marked as paid.');
  }
  if (order.razorpay_order_id !== orderId) {
    console.error('[verify] order id mismatch for', reference);
    return bad(res, 'Payment does not belong to this order.');
  }
  if (order.payment_status === 'paid') return json(res, 200, { ok: true, reference, already: true });

  // --- 3. verify the payment with Razorpay itself --------------------
  let payment;
  try {
    const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpaySecret}`).toString('base64');
    const r = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`razorpay ${r.status}`);
    payment = await r.json();
  } catch (e) {
    // Fail closed: never mark paid on an unverified payment. The buyer is
    // told the truth and /api/razorpay-webhook fulfils once Razorpay reports.
    console.error('[verify] payment lookup failed', e.message);
    return json(res, 503, {
      error: 'Your payment could not be confirmed yet. You will receive a confirmation email shortly — your order is safe.',
      pending: true,
    });
  }

  if (payment.order_id !== orderId) {
    console.error('[verify] payment not on expected order for', reference);
    return bad(res, 'Payment does not belong to this order.');
  }
  if (payment.status !== 'captured') {
    console.error('[verify] payment not captured for', reference, payment.status);
    return bad(res, `Your payment is not confirmed yet (status: ${payment.status}). You will receive an email once it clears.`);
  }
  if (String(payment.currency || '').toUpperCase() !== 'INR') {
    console.error('[verify] wrong currency for', reference, payment.currency);
    return bad(res, 'Payment currency mismatch. Your order was not marked as paid.');
  }
  if (Number(payment.amount) !== Number(order.total_paise)) {
    console.error('[verify] amount mismatch for', reference, 'expected', order.total_paise, 'got', payment.amount);
    return bad(res, 'Payment amount does not match this order.');
  }

  // --- 4. atomic pending → paid (only one caller wins) ---------------
  let updated;
  try {
    updated = await sb.update('orders', { reference, payment_status: 'pending' }, {
      payment_status: 'paid',
      status: 'confirmed',
      razorpay_order_id: orderId,
    });
  } catch (e) {
    console.error('[verify] update failed', e);
    return json(res, 500, { error: 'Could not confirm your order.' });
  }
  if (!updated.length) {
    // The webhook (or a racing call) already fulfilled it — acknowledge.
    return json(res, 200, { ok: true, reference, already: true });
  }

  const rowsText = (order.items || [])
    .map(i => `  ${i.qty} × ${i.name} — ${inr(i.price_paise * i.qty)}`)
    .join('\n');

  sendEmail({
    to: order.email,
    subject: `[Fan Archive] Order ${reference} confirmed — thank you!`,
    text:
      `Hi ${order.name},\n\nThank you for your order. Payment received.\n\n` +
      `Order: ${reference}\nPayment ID: ${paymentId}\n\n${rowsText}\n` +
      `  Subtotal: ${inr(order.subtotal_paise)}\n  Shipping: ${order.shipping_paise ? inr(order.shipping_paise) : 'Free'}\n` +
      `  Total paid: ${inr(order.total_paise)}\n\nShipping to:\n` +
      `${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n` +
      `${order.city}, ${order.state} ${order.pincode}\n\nWe will email you again when it ships.\n\n— Prabhas Fan Archive`,
  }).catch(e => console.error('[verify] buyer email failed', e.message));

  sendEmail({
    to: env.ownerEmail,
    subject: `[Fan Archive] PAID order ${reference} — ${inr(order.total_paise)}`,
    text:
      `Paid order ${reference}\nRazorpay payment: ${paymentId}\n\n${order.name} <${order.email}>${order.phone ? ' · ' + order.phone : ''}\n` +
      `${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n${order.city}, ${order.state} ${order.pincode}\n\n` +
      `${rowsText}\n  Total paid: ${inr(order.total_paise)}\n\nManage: ${env.siteUrl}/admin/#/orders`,
  }).catch(e => console.error('[verify] owner email failed', e.message));

  return json(res, 200, { ok: true, reference, payment_id: paymentId });
}
