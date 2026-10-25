// GET /api/cron-release-stale — releases inventory reserved by online
// checkouts that were abandoned.
//
// Stripe and Razorpay orders reserve stock at creation (reserve_stock) and
// only a verified payment keeps it. If a buyer opens checkout and walks
// away, the order sits 'pending' forever and the units stay reserved.
// This endpoint (Vercel cron, see vercel.json `crons`) cancels orders that
// have been pending for STALE_HOURS and gives the stock back.
//
// Scope limits — deliberately conservative:
//   * only payment_method stripe|razorpay (online checkout windows; Stripe
//     sessions expire in 24 h by default),
//   * only status 'new' AND payment_status 'pending' (a CAS update re-checks
//     both, so a payment landing mid-run wins and nothing is released),
//   * never touches COD or direct-UPI orders, which the owner settles by
//     hand, and never emails buyers.
//
// Auth: Vercel cron calls the path with `Authorization: Bearer ${CRON_SECRET}`.
// If CRON_SECRET is unset the endpoint refuses (503); a missing or wrong
// bearer is 403. It is not a public endpoint.

import crypto from 'node:crypto';
import { sb, json, restoreStock } from './_lib.js';

const STALE_HOURS = 24;
const BATCH = 50;

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const secret = process.env.CRON_SECRET;
  if (!secret) return json(res, 503, { error: 'CRON_SECRET is not configured' });

  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  const cutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();

  let stale;
  try {
    stale = await sb.select('orders', {
      eq: { payment_method: 'stripe', payment_status: 'pending', status: 'new' },
      lt: { created_at: cutoff },
      limit: BATCH,
    });
    const staleRzp = await sb.select('orders', {
      eq: { payment_method: 'razorpay', payment_status: 'pending', status: 'new' },
      lt: { created_at: cutoff },
      limit: BATCH,
    });
    stale = [...stale, ...staleRzp];
  } catch (e) {
    console.error('[cron] stale lookup failed', e.message);
    return json(res, 500, { error: 'Lookup failed' });
  }

  let released = 0;
  for (const order of stale) {
    // Atomic re-check: if a webhook paid it in the meantime, 0 rows update.
    let updated;
    try {
      updated = await sb.update('orders',
        { reference: order.reference, payment_status: 'pending', status: 'new' },
        { status: 'cancelled' });
    } catch (e) {
      console.error('[cron] cancel failed for', order.reference, e.message);
      continue;
    }
    if (!updated.length) continue;

    const tracked = (order.items || [])
      .filter(i => i && i.product_id)
      .map(i => ({ id: String(i.product_id), qty: Math.max(1, Math.floor(Number(i.qty) || 1)) }));
    await restoreStock(tracked);
    released++;
    console.log('[cron] released stale order', order.reference);
  }

  return json(res, 200, { ok: true, scanned: stale.length, released });
}
