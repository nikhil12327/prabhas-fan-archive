// POST /api/moderate — approve or reject a fan photo submission.
//
// The browser sends the fan's own Supabase access token. We verify it, confirm
// the user is in public.admins, then move the file out of the private
// `submissions` bucket into the public `wall` bucket. Doing the move server-side
// with the service role keeps the private bucket unreachable from the client.

import { env, sb, storage, verifyUser, isAdminUser, json, publicUrl, rateLimit, clientIp } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  // --- auth: the caller must be a signed-in admin -------------------
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await verifyUser(token);
  if (!user?.sub) return json(res, 401, { error: 'Sign in first.' });
  if (!(await isAdminUser(user.sub))) return json(res, 403, { error: 'Not an admin account.' });

  // --- payload ------------------------------------------------------
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return json(res, 400, { error: 'Invalid JSON' }); }

  // Admin-only, but still rate-limit the action endpoint.
  const rl = rateLimit('moderate', clientIp(req), Number(process.env.MODERATE_RATE_LIMIT ?? 30));
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return json(res, 429, { error: 'Too many moderation actions. Try again shortly.' });
  }

  const id = String(body.id || '');
  const action = body.action; // 'approve' | 'reject'
  if (!id || !['approve', 'reject'].includes(action)) {
    return json(res, 400, { error: 'id and a valid action are required.' });
  }

  let rows;
  try { rows = await sb.select('photo_submissions', { eq: { id } }); }
  catch (e) { console.error('[moderate] lookup failed', e); return json(res, 500, { error: 'Lookup failed.' }); }

  const sub = rows[0];
  if (!sub) return json(res, 404, { error: 'Submission not found.' });
  if (sub.status !== 'pending') return json(res, 409, { error: `Already ${sub.status}.` });

  // `storage_path` is client-inserted data — treat it as untrusted. Only a
  // plain filename (no slashes, no dot-dot) is ever fetched or deleted, so a
  // crafted row can never make the service role touch another bucket or path.
  const srcName = String(sub.storage_path || '').split('/').pop() || '';
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(srcName) || srcName.includes('..')) {
    console.error('[moderate] unsafe storage_path on submission', id, sub.storage_path);
    return json(res, 400, { error: 'This submission has an unsafe file path and cannot be processed.' });
  }

  const stamp = { reviewed_at: new Date().toISOString(), reviewed_by: user.sub };

  // --- reject: mark it and drop the file ---------------------------
  if (action === 'reject') {
    try {
      await sb.update('photo_submissions', { id }, { ...stamp, status: 'rejected' });
      await storage.remove('submissions', srcName).catch(e => {
        console.warn('[moderate] could not delete rejected file', e.message);
      });
    } catch (e) {
      console.error('[moderate] reject failed', e);
      return json(res, 500, { error: 'Could not reject submission.' });
    }
    return json(res, 200, { ok: true, status: 'rejected' });
  }

  // --- approve: copy to the public wall bucket, then mark approved --
  // Extension is re-derived from the sanitized name and constrained to a
  // short alphanumeric token before it is used in the destination filename.
  const extMatch = /^[a-z0-9]{1,8}$/.exec((srcName.split('.').pop() || '').toLowerCase());
  const ext = extMatch ? extMatch[0] : 'jpg';
  const dest = `approved-${sub.id}.${ext}`;

  try {
    const file = await storage.get('submissions', srcName);
    if (!file) return json(res, 404, { error: 'The uploaded file is missing.' });

    await storage.put('wall', dest, file.buffer, file.type);
    await sb.update('photo_submissions', { id }, { ...stamp, status: 'approved', wall_path: dest });
    await storage.remove('submissions', srcName).catch(e => {
      console.warn('[moderate] could not clear source file', e.message);
    });

    return json(res, 200, { ok: true, status: 'approved', url: publicUrl('wall', dest) });
  } catch (e) {
    console.error('[moderate] approve failed', e);
    return json(res, 500, { error: 'Could not approve submission.' });
  }
}
