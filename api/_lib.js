// Shared helpers for the fan-archive API routes.
// Zero dependencies: Supabase, Stripe and Resend are all called over REST
// with the global fetch available in Node 18+. Secrets live only here,
// read from Vercel environment variables — never in the browser bundle.

export const env = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY || '', // server-only, never shipped
  anonKey: process.env.SUPABASE_ANON_KEY || '',
  stripeKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET || '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpaySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhook: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  resendKey: process.env.RESEND_API_KEY || '',
  ownerEmail: process.env.OWNER_EMAIL || '',
  siteUrl: process.env.SITE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
};

const SB_HEADERS = () => ({
  apikey: env.serviceRole,
  Authorization: `Bearer ${env.serviceRole}`,
  'Content-Type': 'application/json',
});

/** Minimal Supabase REST (PostgREST) client using the service role. */
export const sb = {
  async select(table, { eq, in_, order, limit } = {}) {
    let url = `${env.supabaseUrl}/rest/v1/${table}?select=*`;
    if (eq) for (const [k, v] of Object.entries(eq)) url += `&${k}=eq.${encodeURIComponent(v)}`;
    // PostgREST needs `col=in.(a,b)` — no `eq.` prefix, and the list must not be encoded.
    if (in_) for (const [k, list] of Object.entries(in_)) url += `&${k}=in.(${list.map(encodeURIComponent).join(',')})`;
    if (order) url += `&order=${order.field}.${order.ascending ? 'asc' : 'desc'}`;
    if (limit) url += `&limit=${limit}`;
    const r = await fetch(url, { headers: SB_HEADERS() });
    if (!r.ok) throw new Error(`select ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
  async insert(table, rows) {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...SB_HEADERS(), Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`insert ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
  async update(table, match, patch) {
    let url = `${env.supabaseUrl}/rest/v1/${table}?`;
    url += Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { ...SB_HEADERS(), Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`update ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
};

/** Validate a caller's Supabase auth JWT. Returns the user or null. */
export async function verifyUser(bearerToken) {
  if (!bearerToken) return null;
  const r = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.anonKey || env.serviceRole, Authorization: `Bearer ${bearerToken}` },
  });
  if (!r.ok) return null;
  return r.json();
}

/** Check whether a user id is in public.admins (server-side, service role). */
export async function isAdminUser(userId) {
  const rows = await sb.select('admins', { eq: { user_id: userId } });
  return rows.length > 0;
}

/** Supabase Storage REST helpers (service role). */
export const storage = {
  async get(bucket, path) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      headers: { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}` },
    });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || 'image/jpeg';
    return { buffer: Buffer.from(await r.arrayBuffer()), type };
  },
  async put(bucket, path, buffer, contentType) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.serviceRole,
        Authorization: `Bearer ${env.serviceRole}`,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!r.ok) throw new Error(`storage put ${bucket}/${path}: ${r.status} ${await r.text()}`);
    return true;
  },
  async remove(bucket, path) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'DELETE',
      headers: { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}` },
    });
    // 404 means already gone — that is fine for a delete.
    if (!r.ok && r.status !== 404) throw new Error(`storage remove ${bucket}/${path}: ${r.status}`);
    return true;
  },
};

/** Public URL for an object in a public bucket. */
export function publicUrl(bucket, path) {
  return `${env.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

/** Send an email through Resend's REST API. Returns true on success. */
export async function sendEmail({ to, subject, text, html }) {
  if (!env.resendKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping send');
    return false;
  }
  const from = process.env.EMAIL_FROM || 'Prabhas Fan Archive <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!r.ok) {
    console.error('[email] failed', r.status, await r.text());
    return false;
  }
  return true;
}

/** Standard JSON response for a Vercel function. */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------
   Best-effort abuse throttling.
   These buckets live in the function instance's memory: each serverless
   instance keeps its own counts, so this is not a global WAF — but it
   blunts the realistic burst attacks (order spam that floods the owner's
   inbox, or hammering the moderation endpoint). `max` is env-tunable;
   values <= 0 disable the limiter entirely.
   ------------------------------------------------------------------ */
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000;

export function rateLimit(name, id, max) {
  if (!(max > 0)) return { ok: true };
  const now = Date.now();
  const key = `${name}:${id}`;
  let hit = HITS.get(key);
  if (!hit || now - hit.t0 > WINDOW_MS) { hit = { t0: now, n: 0 }; HITS.set(key, hit); }
  hit.n++;
  // Safety valve: never let the map grow without bound on a long-lived instance.
  if (HITS.size > 5000) HITS.clear();
  if (hit.n > max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hit.t0 + WINDOW_MS - now) / 1000)) };
  }
  return { ok: true };
}

/** Best caller identity available on Vercel (first hop of X-Forwarded-For). */
export function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

/** Human-facing order code, e.g. PA-8F3K2 */
export function makeRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `PA-${s}`;
}

/** ₹ formatting for emails and confirmations. */
export function inr(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
