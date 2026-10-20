// POST /api/stripe-webhook — marks orders paid when Stripe confirms payment.
//
// This handler reads the RAW request body itself, because Stripe's signature
// check must run over the exact bytes that were sent. Vercel parses JSON into
// req.body for us, which would invalidate the signature, so we bypass that.
//
// Verified with Node's built-in crypto (HMAC SHA-256) — no npm dependency.

import crypto from 'node:crypto';
import { env, sb, sendEmail, json, inr } from './_lib.js';

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

/** Constant-time verification of Stripe's `t=...,v1=...` header. */
function verify(sigHeader, payload, secret) {
  const parts = Object.fromEntries(
    String(sigHeader).split(',').map(p => p.split('=').map(s => s.trim()))
  );
  if (!parts.t || !parts.v1) return false;
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

  // Acknowledge quickly; we only care about successful checkouts.
  if (event.type !== 'checkout.session.completed') return json(res, 200, { received: true });

  const session = event.data.object;
  const reference = session.metadata?.order_reference;
  if (!reference) {
    console.error('[webhook] no order_reference on session', session.id);
    return json(res, 200, { received: true });
  }

  try {
    const updated = await sb.update(
      'orders',
      { reference },
      { payment_status: 'paid', stripe_session_id: session.id, status: 'confirmed' }
    );
    const order = updated[0];
    if (!order) { console.error('[webhook] order not found', reference); return json(res, 200, { received: true }); }

    const rows = order.items
      .map(i => `  ${i.qty} × ${i.name} — ${inr(i.price_paise * i.qty)}`)
      .join('\n');

    // Receipt to the buyer.
    sendEmail({
      to: order.email,
      subject: `[Fan Archive] Order ${reference} confirmed — thank you!`,
      text:
        `Hi ${order.name},\n\nThank you for your order. Payment received.\n\n` +
        `Order: ${reference}\n\n${rows}\n` +
        `  Subtotal: ${inr(order.subtotal_paise)}\n` +
        `  Shipping: ${order.shipping_paise ? inr(order.shipping_paise) : 'Free'}\n` +
        `  Total paid: ${inr(order.total_paise)}\n\n` +
        `Shipping to:\n${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n` +
        `${order.city}, ${order.state} ${order.pincode}\n\n`+
        `We will email you again when it ships.\n\n— Prabhas Fan Archive`,
    }).catch(e => console.error('[webhook] buyer email failed', e));

    // Alert to the owner.
    sendEmail({
      to: env.ownerEmail,
      subject: `[Fan Archive] PAID order ${reference} — ${inr(order.total_paise)}`,
      text:
        `Paid order ${reference}\n\n${order.name} <${order.email}>${order.phone ? ' · ' + order.phone : ''}\n` +
        `${order.address_line1}${order.address_line2 ? ', ' + order.address_line2 : ''}\n` +
        `${order.city}, ${order.state} ${order.pincode}\n\n${rows}\n` +
        `  Total paid: ${inr(order.total_paise)}\n\nManage: ${env.siteUrl}/admin/#/orders`,
    }).catch(e => console.error('[webhook] owner email failed', e));
  } catch (e) {
    console.error('[webhook] update failed', e);
    return json(res, 500, { error: 'Update failed' });
  }

  return json(res, 200, { received: true });
}
