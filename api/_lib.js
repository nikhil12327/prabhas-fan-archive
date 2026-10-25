// Shared helpers for the fan-archive API routes.
// Zero dependencies: Supabase, Stripe and Resend are all called over REST
// with the global fetch available in Node 18+. Secrets live only here,
// read from Vercel environment variables — never in the browser bundle.

import crypto from 'node:crypto';

// Every outbound call is bounded: a hung provider must not pin a function.
export const FETCH_TIMEOUT_MS = 10_000;
const opts = extra => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...extra });

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
  async select(table, { eq, in_, lt, order, limit } = {}) {
    let url = `${env.supabaseUrl}/rest/v1/${table}?select=*`;
    if (eq) for (const [k, v] of Object.entries(eq)) url += `&${k}=eq.${encodeURIComponent(v)}`;
    // PostgREST needs `col=in.(a,b)` — no `eq.` prefix, and the list must not be encoded.
    if (in_) for (const [k, list] of Object.entries(in_)) url += `&${k}=in.(${list.map(encodeURIComponent).join(',')})`;
    if (lt) for (const [k, v] of Object.entries(lt)) url += `&${k}=lt.${encodeURIComponent(v)}`;
    if (order) url += `&order=${order.field}.${order.ascending ? 'asc' : 'desc'}`;
    if (limit) url += `&limit=${limit}`;
    const r = await fetch(url, opts({ headers: SB_HEADERS() }));
    if (!r.ok) throw new Error(`select ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
  async insert(table, rows) {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/${table}`, opts({
      method: 'POST',
      headers: { ...SB_HEADERS(), Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    }));
    if (!r.ok) throw new Error(`insert ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
  /** Call a Postgres function (RPC). Non-2xx throws with `.status` attached. */
  async rpc(name, args) {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, opts({
      method: 'POST',
      headers: { ...SB_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    }));
    if (!r.ok) {
      const err = new Error(`rpc ${name}: ${r.status} ${await r.text()}`);
      err.status = r.status;
      throw err;
    }
    // Void-returning functions answer 204 with no body.
    const text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  },
  async update(table, match, patch) {
    let url = `${env.supabaseUrl}/rest/v1/${table}?`;
    url += Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
    const r = await fetch(url, opts({
      method: 'PATCH',
      headers: { ...SB_HEADERS(), Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }));
    if (!r.ok) throw new Error(`update ${table}: ${r.status} ${await r.text()}`);
    return r.json();
  },
};

/** Validate a caller's Supabase auth JWT. Returns the user or null. */
export async function verifyUser(bearerToken) {
  if (!bearerToken) return null;
  const r = await fetch(`${env.supabaseUrl}/auth/v1/user`, opts({
    headers: { apikey: env.anonKey || env.serviceRole, Authorization: `Bearer ${bearerToken}` },
  }));
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
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, opts({
      headers: { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}` },
    }));
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || 'image/jpeg';
    return { buffer: Buffer.from(await r.arrayBuffer()), type };
  },
  async put(bucket, path, buffer, contentType) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, opts({
      method: 'POST',
      headers: {
        apikey: env.serviceRole,
        Authorization: `Bearer ${env.serviceRole}`,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buffer,
    }));
    if (!r.ok) throw new Error(`storage put ${bucket}/${path}: ${r.status} ${await r.text()}`);
    return true;
  },
  async remove(bucket, path) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, opts({
      method: 'DELETE',
      headers: { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}` },
    }));
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
  const r = await fetch('https://api.resend.com/emails', opts({
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  }));
  if (!r.ok) {
    console.error('[email] failed', r.status, await r.text());
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------
   Atomic inventory. reserve_stock/restore_stock are SECURITY DEFINER
   functions (service_role only) that decrement/restore inside SQL with a
   `stock >= qty` predicate, so concurrent orders cannot oversell.

   'legacy' = the RPC does not exist yet (migration not applied): callers
   proceed with a loud log rather than bricking checkout before the
   migration lands. Every other failure is surfaced as 'error'.
   ------------------------------------------------------------------ */
export async function reserveStock(list) {
  if (!list || !list.length) return 'ok';
  try {
    for (const { id, qty } of list) {
      const r = await sb.rpc('reserve_stock', { p_product_id: id, p_qty: qty });
      if (r === 'insufficient' || r === 'invalid') return 'insufficient';
    }
    return 'ok';
  } catch (e) {
    if (e.status === 404 || e.status === 400) {
      console.error('[stock] reserve_stock RPC unavailable — migration not applied?');
      return 'legacy';
    }
    console.error('[stock] reserve failed', e.message);
    return 'error';
  }
}

export async function restoreStock(list) {
  if (!list || !list.length) return;
  try {
    for (const { id, qty } of list) {
      await sb.rpc('restore_stock', { p_product_id: id, p_qty: qty });
    }
  } catch (e) {
    if (e.status === 404 || e.status === 400) return; // pre-migration: nothing was reserved
    console.error('[stock] restore failed', e.message);
  }
}

/** Standard JSON response for a Vercel function. */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Reject oversized request bodies early (before parsing/provider work).
 *  Vercel's own body parser caps at ~4.5 MB; this is a much tighter bound
 *  for our small JSON payloads. Absent content-length (chunked) is left to
 *  the platform limit. */
export const MAX_JSON_BYTES = 32 * 1024;
export function bodyTooLarge(req) {
  const len = Number(req.headers?.['content-length']);
  return Number.isFinite(len) && len > MAX_JSON_BYTES;
}

/* ------------------------------------------------------------------
   Abuse throttling.

   PRIMARY: `public.rate_limit_hit` in Postgres (SECURITY DEFINER) — one
   atomic upsert shared by every serverless instance, so the limit is
   global rather than per-instance. Called via PostgREST with the service
   role; only service_role has EXECUTE on it.

   FALLBACK: the per-instance in-memory counter below, used when the
   database is unreachable OR the migration has not been applied yet
   (the RPC then answers 404/400 and we degrade instead of failing).

   Limits are CLAMPED, never disabled: a missing, zero, negative or
   garbage env value falls back to the default maximum, so production
   can never end up unlimited through a typo. `max <= 0` from callers is
   treated the same way (default), not as "off".
   ------------------------------------------------------------------ */
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000;

/** Clamp an env-provided limit into [1, 1000]; anything else → fallback. */
export function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 1000);
}

function memoryHit(key, max) {
  const now = Date.now();
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

export async function rateLimit(name, id, max, fallbackMax = 12) {
  const limit = clampLimit(max, fallbackMax);
  const retryAfter = Math.ceil(WINDOW_MS / 1000);

  // 1) local layer (always counts; keeps a floor if the store is down)
  const local = memoryHit(`${name}:${id}`, limit);
  if (!local.ok) return local;

  // 2) persistent layer (global across instances)
  try {
    if (env.supabaseUrl && env.serviceRole) {
      const r = await fetch(`${env.supabaseUrl}/rest/v1/rpc/rate_limit_hit`, {
        method: 'POST',
        headers: { ...SB_HEADERS(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_bucket: name,
          p_key: String(id).slice(0, 120),
          p_max: limit,
          p_window_seconds: Math.round(WINDOW_MS / 1000),
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const allowed = await r.json();
        if (typeof allowed === 'boolean') {
          return allowed ? { ok: true } : { ok: false, retryAfter };
        }
      }
      // non-boolean or non-OK: RPC missing/legacy → memory layer stands in
    }
  } catch (e) {
    console.warn('[ratelimit] persistent limiter unavailable:', e.message);
  }
  return { ok: true };
}

/**
 * Best caller identity on Vercel. Per Vercel's docs the platform OVERWRITES
 * x-forwarded-for / x-real-ip with the real client IP specifically to prevent
 * spoofing, and the x-vercel-* family is platform-set and never client-forgeable.
 * We prefer those, then fall back to the first x-forwarded-for hop (correct
 * when Vercel set it), then to a shared bucket.
 */
export function clientIp(req) {
  const h = req.headers || {};
  const v = String(h['x-vercel-forwarded-for'] || h['x-real-ip'] || '').trim();
  if (v) return v.split(',')[0].trim();
  const xff = String(h['x-forwarded-for'] || '').trim();
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/**
 * Human-facing order code, e.g. PA-8F3K2.
 * 32 symbols (no I/O/0/1) over 5 characters, drawn from crypto.randomBytes:
 * 256 % 32 === 0, so the bytes map with no modulo bias. Uniqueness is
 * enforced by the DB unique constraint (callers retry on 23505).
 */
export function makeRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[bytes[i] % alphabet.length];
  return `PA-${s}`;
}

/** ₹ formatting for emails and confirmations. */
export function inr(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
