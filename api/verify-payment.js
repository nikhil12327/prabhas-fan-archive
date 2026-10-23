// POST /api/verify-payment — verifies a Razorpay checkout signature.
//
// Razorpay signs the checkout as HMAC-SHA256(order_id + "|" + payment_id)
// with the KEY_SECRET. We recompute it here and compare in constant time.
// Only a matching signature flips the order to 'paid'.

import crypto from 'node:crypto';
import { env, sb, sendEmail, json, inr } from './_lib.js';

function bad(res, msg) { return json(res, 400, { error: msg }); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!env.razorpaySecret) {
    console.error('[verify] RAZORPAY_KEY_SECRET is not set');
    return json(res, 503, { error: 'Online payment is not configured yet.' });
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

  // --- constant-time signature check ----------------------------------
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

  // --- look up the order and confirm it matches the Razorpay order ----
  let rows;
  try { rows = await sb.select('orders', { eq: { reference } }); }
  catch (e) { console.error('[verify] lookup failed', e); return json(res, 500, { error: 'Could not confirm the order.' }); }

  const order = rows[0];
  if (!order) return bad(res, 'Order not found.');
  if (order.stripe_session_id && order.stripe_session_id !== orderId) {
    console.error('[verify] order id mismatch for', reference);
    return bad(res, 'Payment does not belong to this order.');
  }
  if (order.payment_status === 'paid') return json(res, 200, { ok: true, reference, already: true });

  // --- money is real: mark paid and notify ----------------------------
  try {
    await sb.update('orders', { reference }, {
      payment_status: 'paid',
      status: 'confirmed',
      stripe_session_id: orderId,
    });
  } catch (e) {
    console.error('[verify] update failed', e);
    return json(res, 500, { error: 'Could not confirm your order.' });
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
  }).catch(e => console.error('[verify] buyer email failed', e));

  sendEmail({
    to: env.ownerEmail,
    subject: `[Fan Archive] PAID order ${reference} — ${inr(order.total_paise)}`,
    text:
      `Paid order ${reference}\nRazorpay payment: ${paymentId}\n\n${order.name} <${order.email}>${order.phone ? ' · ' + order.phone : ''}\n` +
      `${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n${order.city}, ${order.state} ${order.pincode}\n\n` +
      `${rowsText}\n  Total paid: ${inr(order.total_paise)}\n\nManage: ${env.siteUrl}/admin/#/orders`,
  }).catch(e => console.error('[verify] owner email failed', e));

  return json(res, 200, { ok: true, reference, payment_id: paymentId });
}
