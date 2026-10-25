// POST /api/stripe-webhook — marks orders paid when Stripe confirms payment.
//
// This handler reads the RAW request body itself, because Stripe's signature
// check must run over the exact bytes that were sent. Vercel parses JSON into
// req.body for us, which would invalidate the signature, so we bypass that.
//
// Verified with Node's built-in crypto (HMAC SHA-256) — no npm dependency.

import crypto from 'node:crypto';
import { env, sb, sendEmail, json, inr, bodyTooLarge } from './_lib.js';

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

/** Constant-time verification of Stripe's `t=...,v1=...` header,
 *  including the replay window: a captured header older than TOLERANCE
 *  seconds is refused even if the HMAC matches. */
const TOLERANCE_S = 300; // Stripe recommends 5 minutes

function verify(sigHeader, payload, secret) {
  const parts = Object.fromEntries(
    String(sigHeader).split(',').map(p => p.split('=').map(s => s.trim()))
  );
  if (!parts.t || !parts.v1) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TOLERANCE_S) {
    console.error('[webhook] signature timestamp outside tolerance');
    return false;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${payload}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (bodyTooLarge(req)) return json(res, 413, { error: 'Payload too large.' });

  let payload;
  try { payload = (await rawBody(req)).toString('utf8'); }
  catch { return json(res, 400, { error: 'Could not read body' }); }

  if (!env.stripeWebhook) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return json(res, 500, { error: 'Webhook secret not configured' });
  }

  const sig = req.headers['stripe-signature'];
  if (!verify(sig, payload, env.stripeWebhook)) {
    console.error('[webhook] signature verification failed');
    return json(res, 400, { error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(payload); }
  catch { return json(res, 400, { error: 'Invalid payload' }); }

  // --- event routing ---------------------------------------------------
  // Cards settle synchronously, so `checkout.session.completed` already
  // carries payment_status 'paid'. UPI does not: Stripe sends `completed`
  // while the money is still in flight (payment_status 'unpaid'), then
  // follows up with async_payment_succeeded or async_payment_failed once
  // the bank confirms. Fulfilling on `completed` alone would mark a UPI
  // order paid before the funds actually arrive.
  // https://docs.stripe.com/checkout/fulfillment
  const HANDLED = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
  ]);
  if (!HANDLED.has(event.type)) return json(res, 200, { received: true });

  const session = event.data.object;
  const reference = session.metadata?.order_reference;
  if (!reference) {
    console.error('[webhook] no order_reference on session', session.id);
    return json(res, 200, { received: true });
  }
  if (!/^PA-[A-Z2-9]{5}$/.test(reference)) {
    console.error('[webhook] malformed order reference', reference);
    return json(res, 200, { received: true });
  }

  // Bind every state change to OUR stored session for this order, and read
  // the current row once so below we never act on a substituted session.
  let order;
  try {
    const rows = await sb.select('orders', { eq: { reference } });
    order = rows[0];
  } catch (e) {
    console.error('[webhook] order lookup failed', e);
    return json(res, 500, { error: 'Lookup failed' });
  }
  if (!order) {
    console.error('[webhook] order not found', reference);
    return json(res, 200, { received: true });
  }
  if (order.stripe_session_id && order.stripe_session_id !== session.id) {
    console.error('[webhook] session mismatch for', reference, session.id);
    return json(res, 200, { received: true });
  }
  if (session.currency && String(session.currency).toLowerCase() !== 'inr') {
    console.error('[webhook] currency mismatch for', reference, session.currency);
    return json(res, 200, { received: true });
  }
  if (session.amount_total != null && order.total_paise != null &&
      Number(session.amount_total) !== Number(order.total_paise)) {
    console.error('[webhook] amount mismatch for', reference,
      'expected', order.total_paise, 'got', session.amount_total);
    return json(res, 200, { received: true });
  }

  // `completed` + unpaid = UPI still settling. Leave the order pending and
  // wait for the async event rather than fulfilling early.
  if (event.type === 'checkout.session.completed' && session.payment_status !== 'paid') {
    console.log('[webhook] checkout completed, awaiting async payment', reference);
    return json(res, 200, { received: true });
  }

  // Session timed out before the buyer paid. payment_status stays 'pending'
  // so the admin panel keeps showing it as unpaid.
  if (event.type === 'checkout.session.expired') {
    console.log('[webhook] checkout expired without payment', reference);
    return json(res, 200, { received: true });
  }

  // A delayed payment failed to settle (UPI rejected, timed out, or bounced).
  // Conditional on still-pending: a failed event can never overwrite paid.
  if (event.type === 'checkout.session.async_payment_failed') {
    try {
      const flipped = await sb.update('orders', { reference, payment_status: 'pending' },
        { payment_status: 'failed', stripe_session_id: session.id });
      if (flipped.length) console.log('[webhook] async payment failed', reference);
    } catch (e) {
      console.error('[webhook] failed-mark update errored', e);
      return json(res, 500, { error: 'Update failed' });
    }
    return json(res, 200, { received: true });
  }

  // Money has actually landed: card settled, or async payment succeeded.
  // Atomic pending → paid: replays and concurrent deliveries find 0 rows,
  // so fulfilment and both emails happen exactly once.
  let order2;
  try {
    const updated = await sb.update(
      'orders',
      { reference, payment_status: 'pending' },
      { payment_status: 'paid', stripe_session_id: session.id, status: 'confirmed' }
    );
    order2 = updated[0];
    if (!order2) {
      console.log('[webhook] already fulfilled or not pending', reference);
      return json(res, 200, { received: true, already: true });
    }
  } catch (e) {
    console.error('[webhook] update failed', e);
    return json(res, 500, { error: 'Update failed' });
  }
  const settled = order2;
  const rows = settled.items
      .map(i => `  ${i.qty} × ${i.name} — ${inr(i.price_paise * i.qty)}`)
      .join('\n');

    // Receipt to the buyer.
    sendEmail({
      to: settled.email,
      subject: `[Fan Archive] Order ${reference} confirmed — thank you!`,
      text:
        `Hi ${settled.name},\n\nThank you for your order. Payment received.\n\n` +
        `Order: ${reference}\n\n${rows}\n` +
        `  Subtotal: ${inr(settled.subtotal_paise)}\n` +
        `  Shipping: ${settled.shipping_paise ? inr(settled.shipping_paise) : 'Free'}\n` +
        `  Total paid: ${inr(settled.total_paise)}\n\n` +
        `Shipping to:\n${settled.address_line1}${settled.address_line2 ? ', ' + settled.address_line2 : ''}\n` +
        `${settled.city}, ${settled.state} ${settled.pincode}\n\n`+
        `We will email you again when it ships.\n\n— Prabhas Fan Archive`,
    }).catch(e => console.error('[webhook] buyer email failed', e));

    // Alert to the owner.
    sendEmail({
      to: env.ownerEmail,
      subject: `[Fan Archive] PAID order ${reference} — ${inr(settled.total_paise)}`,
      text:
        `Paid order ${reference}\n\n${settled.name} <${settled.email}>${settled.phone ? ' · ' + settled.phone : ''}\n` +
        `${settled.address_line1}${settled.address_line2 ? ', ' + settled.address_line2 : ''}\n` +
        `${settled.city}, ${settled.state} ${settled.pincode}\n\n${rows}\n` +
        `  Total paid: ${inr(settled.total_paise)}\n\nManage: ${env.siteUrl}/admin/#/orders`,
  }).catch(e => console.error('[webhook] owner email failed', e));

  return json(res, 200, { received: true });
}
