// POST /api/moderate — approve or reject a fan photo submission, or approve/
// reject a birthday wish.
//
// The browser sends the admin's own Supabase access token. We verify it,
// confirm the user is in public.admins, then act. For photos the file is
// moved server-side out of the private `submissions` bucket into the public
// `wall` bucket — but ONLY after the bytes themselves are validated
// (api/_image.js): container signature, structure and pixel dimensions.
// The content-type stored on the public object comes from the SNIFFED type,
// never from the client-declared one, and the destination extension is
// derived from the sniffed format too.
//
// If the database update fails after the copy, the public object is removed
// again (compensating action) so a failed approval can never leave an
// unvalidated or orphaned file publicly reachable.

import { env, sb, storage, verifyUser, isAdminUser, json, publicUrl, rateLimit, clientIp, bodyTooLarge } from './_lib.js';
import { sniffImage } from './_image.js';

const KINDS = { photo: 'photo_submissions', wish: 'wishes' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (bodyTooLarge(req)) return json(res, 413, { error: 'Payload too large.' });

  // --- auth: the caller must be a signed-in admin -------------------
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await verifyUser(token);
  if (!user?.sub) return json(res, 401, { error: 'Sign in first.' });
  if (!(await isAdminUser(user.sub))) return json(res, 403, { error: 'Not an admin account.' });

  // --- payload ------------------------------------------------------
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return json(res, 400, { error: 'Invalid JSON' }); }

  // Admin-only, but still rate-limit the action endpoint: a hijacked admin
  // session must not become an unbounded delete/publish pump.
  const rl = await rateLimit('moderate', clientIp(req), process.env.MODERATE_RATE_LIMIT, 30);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return json(res, 429, { error: 'Too many moderation actions. Try again shortly.' });
  }

  const id = String(body.id || '');
  const action = body.action; // 'approve' | 'reject'
  const kind = body.kind === 'wish' ? 'wish' : 'photo';
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !['approve', 'reject'].includes(action)) {
    return json(res, 400, { error: 'id and a valid action are required.' });
  }
  const table = KINDS[kind];
  const stamp = { reviewed_at: new Date().toISOString() };

  let rows;
  try { rows = await sb.select(table, { eq: { id } }); }
  catch (e) { console.error('[moderate] lookup failed', e); return json(res, 500, { error: 'Lookup failed.' }); }

  const sub = rows[0];
  if (!sub) return json(res, 404, { error: 'Submission not found.' });
  if (sub.status !== 'pending') return json(res, 409, { error: `Already ${sub.status}.` });

  /* ================================================================
     WISHES — text only; no file handling.
     ================================================================ */
  if (kind === 'wish') {
    try {
      await sb.update('wishes', { id }, { ...stamp, status: action === 'approve' ? 'approved' : 'rejected' });
    } catch (e) {
      console.error('[moderate] wish update failed', e);
      return json(res, 500, { error: 'Could not update wish.' });
    }
    return json(res, 200, { ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
  }

  /* ================================================================
     PHOTOS
     ================================================================ */
  // `storage_path` is client-inserted data — treat it as untrusted. Only a
  // plain filename (no slashes, no dot-dot, image extension) is ever fetched
  // or deleted, so a crafted row can never make the service role touch
  // another bucket or path.
  const srcName = String(sub.storage_path || '').split('/').pop() || '';
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(srcName) || srcName.includes('..') ||
      !/\.(jpg|jpeg|png|webp)$/i.test(srcName)) {
    console.error('[moderate] unsafe storage_path on submission', id, sub.storage_path);
    return json(res, 400, { error: 'This submission has an unsafe file path and cannot be processed.' });
  }

  const reviewed = { reviewed_at: stamp.reviewed_at, reviewed_by: user.sub };

  // --- reject: mark it and drop the file ---------------------------
  if (action === 'reject') {
    try {
      await sb.update('photo_submissions', { id }, { ...reviewed, status: 'rejected' });
      await storage.remove('submissions', srcName).catch(e => {
        console.warn('[moderate] could not delete rejected file', e.message);
      });
    } catch (e) {
      console.error('[moderate] reject failed', e);
      return json(res, 500, { error: 'Could not reject submission.' });
    }
    return json(res, 200, { ok: true, status: 'rejected' });
  }

  // --- approve: validate BYTES first, then copy, then mark approved --
  let file;
  try { file = await storage.get('submissions', srcName); }
  catch (e) { console.error('[moderate] fetch failed', e); return json(res, 500, { error: 'Could not read the uploaded file.' }); }
  if (!file) return json(res, 404, { error: 'The uploaded file is missing.' });

  const sniff = sniffImage(file.buffer);
  if (!sniff.ok) {
    console.error('[moderate] rejected invalid image on submission', id, sniff.reason);
    return json(res, 400, {
      error: `This file cannot be published (${sniff.reason}). Reject it and ask the fan to re-upload a JPG, PNG or WebP photo.`,
    });
  }

  // Destination name is entirely server-generated: fixed prefix + the
  // submission's own uuid + an extension derived from the SNIFFED format.
  const dest = `approved-${sub.id}.${sniff.ext}`;

  try {
    await storage.put('wall', dest, file.buffer, sniff.type);
    let updated;
    try {
      updated = await sb.update('photo_submissions', { id }, { ...reviewed, status: 'approved', wall_path: dest });
    } catch (e) {
      // DB write failed: pull the just-published object back down so no
      // unrecorded file stays public.
      await storage.remove('wall', dest).catch(() => {});
      throw e;
    }
    if (!updated.length) {
      await storage.remove('wall', dest).catch(() => {});
      return json(res, 409, { error: 'Submission changed state — reload the queue.' });
    }
    await storage.remove('submissions', srcName).catch(e => {
      console.warn('[moderate] could not clear source file', e.message);
    });

    return json(res, 200, { ok: true, status: 'approved', url: publicUrl('wall', dest) });
  } catch (e) {
    console.error('[moderate] approve failed', e);
    return json(res, 500, { error: 'Could not approve submission.' });
  }
}
