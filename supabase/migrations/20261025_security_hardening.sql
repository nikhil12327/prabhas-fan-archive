-- ============================================================
-- 2026-10-25 — security hardening migration
-- Prabhas — The Fan Archive
--
-- WHAT THIS CHANGES (all statements idempotent; safe to re-run):
--   1. orders: add razorpay_order_id (stop overloading stripe_session_id),
--      backfill existing rows, add length caps, narrow column privileges.
--   2. photo_submissions: REMOVE anon SELECT on the base table (it exposed
--      submitter emails + internal review fields of approved rows) and add a
--      public-safe VIEW `photo_wall` exposing only approved public fields.
--      Column-limited INSERT for anonymous fans.
--   3. wishes: column-limited INSERT/SELECT for anonymous callers.
--   4. quiz_scores: table-level score checks, anon INSERT revoked, replaced
--      by a validating, per-IP-throttled SECURITY DEFINER RPC.
--   5. merch_products: anon column grant limited to public catalogue fields.
--   6. admins + orders: explicit revocations for anon; authenticated UPDATE
--      on orders narrowed to the `status` column. is_admin() is (re)created
--      as SECURITY DEFINER so the public read policies keep working for anon
--      once admins is locked down.
--   7. storage: 8 MB + image-only bucket limits, filename policy on uploads.
--   8. New private helper tables + RPCs: rate_limit_hit (persistent rate
--      limiting shared across serverless instances), reserve_stock/
--      restore_stock (atomic inventory), submit_quiz_score, quiz_throttle.
--
-- HOW IT PROTECTS EXISTING RECORDS:
--   No rows are deleted, truncated or reset. Column backfill (razorpay
--   order ids) only copies a value into a new column and nulls the
--   overloaded one for razorpay rows. New CHECK constraints are added
--   NOT VALID so historical rows can never make this migration fail
--   (they are enforced for all new writes immediately).
--
-- APPLY ORDER (code depends on this; see report section H):
--   Apply this migration FIRST, then deploy the matching application code.
--   Between the two steps the photo wall and quiz submission on the old
--   deployment will error until the new code ships (seconds), because the
--   old anon privileges are revoked here.
--
-- ROLLBACK:
--   Safe to roll back privileges only (grants/policies are re-grantable):
--   re-grant select on photo_submissions to anon, re-create ps_public_read,
--   re-grant insert on quiz_scores. Do NOT drop the new columns/tables.
--   No data is destroyed by either direction.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ORDERS: provider-specific payment ids + input length caps
-- ------------------------------------------------------------
alter table public.orders add column if not exists razorpay_order_id text;

create index if not exists orders_razorpay_order_id_idx
  on public.orders (razorpay_order_id) where razorpay_order_id is not null;
create index if not exists orders_stripe_session_id_idx
  on public.orders (stripe_session_id) where stripe_session_id is not null;

-- Backfill: earlier code stored the Razorpay order id in stripe_session_id.
update public.orders
   set razorpay_order_id = stripe_session_id,
       stripe_session_id = null
 where payment_method = 'razorpay'
   and stripe_session_id is not null
   and razorpay_order_id is null;

-- Length caps (NOT VALID: enforced on new rows, never blocks on old data).
alter table public.orders drop constraint if exists orders_name_len;
alter table public.orders add constraint orders_name_len
  check (char_length(name) <= 80) not valid;
alter table public.orders drop constraint if exists orders_email_len;
alter table public.orders add constraint orders_email_len
  check (char_length(email) <= 254) not valid;
alter table public.orders drop constraint if exists orders_phone_len;
alter table public.orders add constraint orders_phone_len
  check (phone is null or char_length(phone) <= 20) not valid;
alter table public.orders drop constraint if exists orders_addr1_len;
alter table public.orders add constraint orders_addr1_len
  check (char_length(address_line1) <= 200) not valid;
alter table public.orders drop constraint if exists orders_addr2_len;
alter table public.orders add constraint orders_addr2_len
  check (address_line2 is null or char_length(address_line2) <= 200) not valid;
alter table public.orders drop constraint if exists orders_city_len;
alter table public.orders add constraint orders_city_len
  check (char_length(city) <= 80) not valid;
alter table public.orders drop constraint if exists orders_state_len;
alter table public.orders add constraint orders_state_len
  check (char_length(state) <= 80) not valid;

-- Anonymous callers can never read, write or touch orders at the privilege
-- level (RLS already returned zero rows; this is the second lock).
revoke all on public.orders from anon;

-- Admins update fulfilment status only: payment_status / totals / payment
-- identifiers change exclusively through the service role (verified flows).
revoke update on public.orders from authenticated;
grant  update (status) on public.orders to authenticated;

-- ------------------------------------------------------------
-- 2. PHOTO SUBMISSIONS: remove PII exposure, add public-safe view
-- ------------------------------------------------------------
-- Old policy: anon could SELECT approved rows from the BASE TABLE, which
-- returned every column — including submitter email, private storage_path,
-- reviewed_by reviewer id and review timestamps.
drop policy if exists ps_public_read on public.photo_submissions;

revoke select on public.photo_submissions from anon;

-- Anonymous fans may INSERT only these columns. status/created_at/
-- reviewed_at/reviewed_by/wall_path are simply not insertable, so a caller
-- cannot set them at all (status falls back to its 'pending' default).
revoke insert on public.photo_submissions from anon, authenticated;
grant  insert (name, email, caption, storage_path)
      on public.photo_submissions to anon, authenticated;

-- Public-safe view: approved submissions, explicitly enumerated public
-- fields only. Runs with the owner's privileges (security_invoker off —
-- the invoker has no table SELECT at all), and the WHERE clause plus the
-- column list are part of the view definition, so no join, extra grant or
-- `select=*` through PostgREST can reach email, storage_path or review data.
create or replace view public.photo_wall as
  select id, name, caption, wall_path, created_at
  from public.photo_submissions
  where status = 'approved' and wall_path is not null;

grant select on public.photo_wall to anon, authenticated;

-- ------------------------------------------------------------
-- 3. WISHES: anonymous callers get insert(name,message) and a
--    column-limited select of the public display fields only.
-- ------------------------------------------------------------
revoke insert on public.wishes from anon, authenticated;
grant  insert (name, message) on public.wishes to anon, authenticated;

revoke select on public.wishes from anon;
grant  select (id, name, message, created_at) on public.wishes to anon;

-- Second lock (RLS already returns zero rows for anon writes): anonymous
-- callers have no UPDATE/DELETE on wishes at all — self-approval is
-- impossible at the privilege layer, not just the policy layer. Authenticated
-- admins keep UPDATE/DELETE, gated by wishes_admin_update / _delete.
revoke update, delete on public.wishes from anon;

-- ------------------------------------------------------------
-- 4. QUIZ SCORES: validate in the database, throttle per IP,
--    anonymous INSERT revoked (RPC is the only write path).
-- ------------------------------------------------------------
alter table public.quiz_scores drop constraint if exists quiz_scores_score_le_total;
alter table public.quiz_scores add constraint quiz_scores_score_le_total
  check (score <= total) not valid;
alter table public.quiz_scores drop constraint if exists quiz_scores_total_max;
alter table public.quiz_scores add constraint quiz_scores_total_max
  check (total <= 100) not valid;

create table if not exists public.quiz_throttle (
  ip       text primary key,
  last_at  timestamptz not null default now(),
  day      date not null default current_date,
  day_count integer not null default 0
);
alter table public.quiz_throttle enable row level security;
revoke all on public.quiz_throttle from anon, authenticated, public;

revoke insert, update, delete on public.quiz_scores from anon, authenticated;
revoke select on public.quiz_scores from anon;
grant  select (name, score, total, created_at) on public.quiz_scores to anon;

-- Admins moderate the leaderboard (admin.js deletes scores directly), and
-- qs_admin_delete already gates that DELETE to is_admin() — without this
-- grant the policy can never fire and the admin UI's delete button silently
-- does nothing. Insert stays revoked: the RPC is the only write path.
grant  delete on public.quiz_scores to authenticated;

create or replace function public.submit_quiz_score(p_name text, p_score int, p_total int)
returns setof public.quiz_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip text := null;
  v_headers text := null;
  v_last timestamptz;
  v_count integer := 0;
  v_rec public.quiz_scores%rowtype;
begin
  p_name := trim(coalesce(p_name, ''));
  if char_length(p_name) < 1 or char_length(p_name) > 40 then
    raise exception 'Name must be 1-40 characters';
  end if;
  if p_total is null or p_total < 1 or p_total > 100 then
    raise exception 'Invalid quiz total';
  end if;
  if p_score is null or p_score < 0 or p_score > p_total then
    raise exception 'Invalid quiz score';
  end if;

  -- Per-IP throttle. x-forwarded-for is gateway-populated (rightmost entry
  -- is the trusted one); if headers are unavailable (local dev) the
  -- throttle is skipped rather than penalising everyone behind one key.
  begin
    v_headers := nullif(current_setting('request.headers', true), '');
    if v_headers is not null then
      v_ip := regexp_replace(
        coalesce(v_headers::json->>'x-forwarded-for',
                 v_headers::json->>'x-real-ip', ''),
        '.*,\s*', '');
    end if;
  exception when others then
    v_ip := null;
  end;

  if v_ip is not null and length(v_ip) between 1 and 64 then
    select t.last_at into v_last
      from public.quiz_throttle t where t.ip = v_ip for update;
    if found and v_last > now() - interval '20 seconds' then
      raise exception 'Please wait a moment before saving another score';
    end if;

    insert into public.quiz_throttle (ip, day, day_count, last_at)
    values (v_ip, current_date, 1, now())
    on conflict (ip) do update set
      last_at = now(),
      day = case when public.quiz_throttle.day < current_date
                 then current_date else public.quiz_throttle.day end,
      day_count = case when public.quiz_throttle.day < current_date
                       then 1 else public.quiz_throttle.day_count + 1 end
    returning day_count into v_count;

    if v_count > 30 then
      raise exception 'Daily score limit reached — try again tomorrow';
    end if;
  end if;

  insert into public.quiz_scores (name, score, total)
  values (p_name, p_score, p_total)
  returning * into v_rec;
  return next v_rec;
end;
$$;

revoke execute on function public.submit_quiz_score(text, int, int) from public;
grant  execute on function public.submit_quiz_score(text, int, int) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. MERCH: anon reads public catalogue columns only
-- ------------------------------------------------------------
revoke select on public.merch_products from anon;
grant  select (id, name, description, price_paise, image_path, active, stock, sort_order)
      on public.merch_products to anon;

-- ------------------------------------------------------------
-- 6. ADMINS: anonymous callers have no business here at all
-- ------------------------------------------------------------
-- is_admin() MUST be SECURITY DEFINER: the public read policies
-- (wishes_public_read, mp_public_read) evaluate it on every candidate row
-- AS THE CALLER. Built as SECURITY INVOKER it read public.admins with the
-- caller's privileges — anon has no SELECT there (next statement) — so any
-- public read that touched a non-approved row died with "permission denied
-- for table admins" (production outage 2026-10-25: the wishes feed and the
-- merch catalogue both 401'd). As DEFINER it runs as the owner, answers only
-- about the caller's own auth.uid(): false for anon, true solely for a real
-- admin. Identical definition to supabase/schema.sql §1; re-running either
-- file converges any drift between the two.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
  );
$$;

-- Policy evaluation needs EXECUTE on the functions the policy references.
grant execute on function public.is_admin() to anon, authenticated;

revoke all on public.admins from anon;

-- ------------------------------------------------------------
-- 7. STORAGE: bucket limits + upload filename policy
-- ------------------------------------------------------------
update storage.buckets
   set file_size_limit = 8388608,                            -- 8 MB
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'submissions';

update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id in ('wall', 'merch');

-- Uploads: safe length, no dot-dot, image extensions only. Combined with
-- the bucket MIME/size limits and the server-side byte sniffing in
-- api/moderate.js, HTML/SVG/script payloads cannot be published.
drop policy if exists sub_insert on storage.objects;
create policy sub_insert on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'submissions'
    and char_length(name) between 1 and 140
    and name !~ '\.\.'
    and lower(name) ~ '\.(jpg|jpeg|png|webp)$'
  );

-- ------------------------------------------------------------
-- 8. PERSISTENT RATE LIMITER (shared across serverless instances)
-- ------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket       text not null,
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 1,
  primary key (bucket, key, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated, public;

create or replace function public.rate_limit_hit(p_bucket text, p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_win timestamptz;
  v_hits integer;
begin
  if p_bucket is null or p_key is null or p_max is null or p_max <= 0 then
    return true;   -- defensive: a misconfigured caller never blocks traffic
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    p_window_seconds := 600;
  end if;

  v_win := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits (bucket, key, window_start, hits)
  values (p_bucket, left(p_key, 120), v_win, 1)
  on conflict (bucket, key, window_start)
  do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  if random() < 0.02 then  -- opportunistic cleanup of expired windows
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_hits <= p_max;
end;
$$;

-- anon/authenticated receive DIRECT execute grants from Supabase's default
-- privileges on every new function, so revoking only from `public` leaves
-- them callable — revoke all three explicitly, then allow only service_role.
revoke execute on function public.rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.rate_limit_hit(text, text, integer, integer) to service_role;

-- ------------------------------------------------------------
-- 9. ATOMIC INVENTORY (reserve at order time, restore on failure/release)
-- ------------------------------------------------------------
create or replace function public.reserve_stock(p_product_id uuid, p_qty integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_qty is null or p_qty < 1 then return 'invalid'; end if;

  update public.merch_products
     set stock = stock - p_qty
   where id = p_product_id and stock is not null and stock >= p_qty;
  if found then return 'ok'; end if;

  if exists (select 1 from public.merch_products
              where id = p_product_id and active and stock is null) then
    return 'ok';           -- unlimited stock
  end if;
  return 'insufficient';
end;
$$;

create or replace function public.restore_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_qty is null or p_qty < 1 then return; end if;
  update public.merch_products
     set stock = stock + p_qty
   where id = p_product_id and stock is not null;
end;
$$;

revoke execute on function public.reserve_stock(uuid, integer) from public, anon, authenticated;
revoke execute on function public.restore_stock(uuid, integer) from public, anon, authenticated;
grant  execute on function public.reserve_stock(uuid, integer) to service_role;
grant  execute on function public.restore_stock(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- VERIFICATION QUERIES (run after applying — expected results noted)
-- ------------------------------------------------------------
-- SELECT has_table_privilege('anon', 'public.photo_submissions', 'SELECT');  -> false
-- SELECT has_table_privilege('anon', 'public.orders', 'SELECT');             -> false
-- SELECT has_table_privilege('anon', 'public.quiz_scores', 'INSERT');        -> false
-- SELECT column_name FROM information_schema.columns          -- view exposes
--  WHERE table_name='photo_wall';  -> id,name,caption,wall_path,created_at
-- SELECT * FROM public.photo_wall LIMIT 1;                     -- approved only
-- Full end-to-end assertions: `npm run test:live` (scripts/test-rls.mjs).
