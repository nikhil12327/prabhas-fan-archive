// POST /api/razorpay-webhook — marks orders paid when Razorpay confirms payment.
//
// This is the safety net behind /api/verify-payment. Verification there is
// driven by the buyer's browser: if they close the tab after the money moves
// but before that POST lands, the order would sit 'pending' forever while the
// payment is real. Razorpay delivers `payment.captured` to this endpoint
// server-to-server, so fulfilment no longer depends on the buyer staying put.
//
// Like the Stripe handler, this reads the RAW body itself: Razorpay signs the
// exact bytes it sends, and Vercel's JSON parsing would invalidate that.
// Verified with Node's built-in crypto (HMAC SHA-256) — no npm dependency.
//
// Configure the endpoint in the Razorpay dashboard (Settings → Webhooks) as
//   https://<your-domain>/api/razorpay-webhook
// subscribing to `payment.captured` and `payment.failed`, and paste the same
// secret into RAZORPAY_WEBHOOK_SECRET.

import crypto from 'node:crypto';
import { env, sb, sendEmail, json, inr } from './_lib.js';

// Razorpay sends the signature in the `x-razorpay-signature` header and needs
// the unparsed body, so JSON parsing is disabled for this route.
export const config = { api: { bodyParser: false } };

/** Collect the raw request body as a Buffer. */
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Constant-time verification of Razorpay's hex HMAC-SHA256 signature. */
function verify(signature, payload, secret) {
  if (!signature || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let payload;
  try { payload = (await rawBody(req)).toString('utf8'); }
  catch { return json(res, 400, { error: 'Could not read body' }); }

  if (!env.razorpayWebhook) {
    console.error('[rzp-webhook] RAZORPAY_WEBHOOK_SECRET is not set');
    return json(res, 500, { error: 'Webhook secret not configured' });
  }

  const sig = req.headers['x-razorpay-signature'];
  if (!verify(sig, payload, env.razorpayWebhook)) {
    console.error('[rzp-webhook] signature verification failed');
    return json(res, 400, { error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(payload); }
  catch { return json(res, 400, { error: 'Invalid payload' }); }

  // --- event routing ---------------------------------------------------
  // `payment.captured` means the money has actually landed, so that is the
  // one that fulfils. `payment.failed` records the failure so the admin panel
  // stops showing the order as merely pending. Everything else is
  // acknowledged without touching the database, which keeps Razorpay's
  // retries quiet.
  const type = String(event.type || event.event || '');
  const payment = event.payload?.payment?.entity;
  if (!payment) return json(res, 200, { received: true });

  const orderId = String(payment.order_id || '');
  const paymentId = String(payment.id || '');
  if (!orderId) return json(res, 200, { received: true });

  // Failures only mark the order failed. Do this BEFORE the lookup so a
  // failed retry of a previously-paid order cannot clobber it: we resolve the
  // row first and check its state below.
  let rows;
  try { rows = await sb.select('orders', { eq: { stripe_session_id: orderId } }); }
  catch (e) { console.error('[rzp-webhook] lookup failed', e); return json(res, 500, { error: 'Lookup failed' }); }

  const order = rows[0];
  if (!order) {
    // Not our order (or an old one stored before we tracked the id). Not an
    // error — Razorpay must not retry forever for a row we will never own.
    console.error('[rzp-webhook] no order for razorpay order', orderId);
    return json(res, 200, { received: true });
  }
  const reference = order.reference;

  if (type === 'payment.failed') {
    // Never downgrade an order that is already paid — a later failed retry
    // for a different attempt must not flip a settled order.
    if (order.payment_status === 'paid') return json(res, 200, { received: true });
    try {
      await sb.update('orders', { reference }, { payment_status: 'failed', stripe_session_id: orderId });
    } catch (e) {
      console.error('[rzp-webhook] failed-mark update errored', e);
      return json(res, 500, { error: 'Update failed' });
    }
    console.log('[rzp-webhook] payment failed', reference, paymentId);
    return json(res, 200, { received: true });
  }

  if (type !== 'payment.captured') return json(res, 200, { received: true });

  // Idempotency: verify-payment may have already flipped this row from the
  // browser, or Razorpay may deliver the same capture twice. Fulfil once and
  // send the emails once.
  if (order.payment_status === 'paid') return json(res, 200, { received: true, already: true });

  // Sanity check the captured amount against what we charged. Razorpay amounts
  // are in paise, same as ours. A mismatch means a tampered or partial payment
  // and must not fulfil.
  if (payment.amount != null && Number(payment.amount) !== Number(order.total_paise)) {
    console.error('[rzp-webhook] amount mismatch for', reference,
      'expected', order.total_paise, 'got', payment.amount);
    return json(res, 200, { received: true });
  }

  // Money has actually landed: mark paid and notify.
  try {
    await sb.update('orders', { reference }, {
      payment_status: 'paid',
      status: 'confirmed',
      stripe_session_id: orderId,
    });
  } catch (e) {
    console.error('[rzp-webhook] update failed', e);
    return json(res, 500, { error: 'Update failed' });
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
  }).catch(e => console.error('[rzp-webhook] buyer email failed', e));

  sendEmail({
    to: env.ownerEmail,
    subject: `[Fan Archive] PAID order ${reference} — ${inr(order.total_paise)}`,
    text:
      `Paid order ${reference}\nRazorpay payment: ${paymentId}\n\n` +
      `${order.name} <${order.email}>${order.phone ? ' · ' + order.phone : ''}\n` +
      `${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n` +
      `${order.city}, ${order.state} ${order.pincode}\n\n${rowsText}\n` +
      `  Total paid: ${inr(order.total_paise)}\n\nManage: ${env.siteUrl}/admin/#/orders`,
  }).catch(e => console.error('[rzp-webhook] owner email failed', e));

  console.log('[rzp-webhook] captured', reference, paymentId);
  return json(res, 200, { received: true });
}
