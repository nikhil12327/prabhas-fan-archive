-- ============================================================
-- Prabhas — The Fan Archive : Supabase schema
-- Run this whole file in the Supabase SQL editor (or `supabase db push`).
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Extensions
-- ------------------------------------------------------------
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Admins — the only rows that pass `is_admin()`
--    After running this file, insert yourself:
--      insert into public.admins (email) values ('you@example.com');
--    then link it to your auth user:
--      update public.admins set user_id = 'AUTH-UID-FROM-auth.users'
--        where email = 'you@example.com';
--    Easiest: sign up through the site's Owner login once, then run the
--    two statements above with the email you signed up with.
-- ------------------------------------------------------------
create table if not exists public.admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  created_at  timestamptz not null default now()
);

-- SECURITY DEFINER so RLS policies can call it without recursing.
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

-- ------------------------------------------------------------
-- 2. Photo submissions (moderated fan photo wall)
--    Anonymous fans INSERT; only admins see/approve. Files land in the
--    private `submissions` bucket and are copied to `wall` on approval.
-- ------------------------------------------------------------
create table if not exists public.photo_submissions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  email       text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  caption     text check (caption is null or char_length(caption) <= 300),
  storage_path text not null,               -- path inside `submissions` bucket
  wall_path   text,                         -- set on approval; path inside `wall` bucket
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
create index if not exists photo_submissions_status_idx
  on public.photo_submissions (status, created_at desc);

-- ------------------------------------------------------------
-- 3. Birthday wishes (moderated)
-- ------------------------------------------------------------
create table if not exists public.wishes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  message     text not null check (char_length(message) between 1 and 400),
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists wishes_status_idx on public.wishes (status, created_at desc);

-- ------------------------------------------------------------
-- 4. Quiz leaderboard
--    Score is written once per completed round; best score per browser
--    is enforced client-side, and again here so the board stays honest.
-- ------------------------------------------------------------
create table if not exists public.quiz_scores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  score      integer not null check (score >= 0),
  total      integer not null check (total > 0),
  created_at timestamptz not null default now()
);
create index if not exists quiz_scores_rank_idx
  on public.quiz_scores (score desc, created_at asc);

-- ------------------------------------------------------------
-- 5. Merch catalogue — admin-editable, no redeploy needed
--    price is in whole paise so ₹1,299.00 is stored as 129900 (no float drift).
-- ------------------------------------------------------------
create table if not exists public.merch_products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  price_paise integer not null check (price_paise >= 0),
  image_path  text,                          -- path inside the public `merch` bucket
  active      boolean not null default true,
  stock       integer,                       -- null = unlimited
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists merch_products_active_idx
  on public.merch_products (active, sort_order);

-- ------------------------------------------------------------
-- 6. Orders — created only by the serverless function (service role)
--    payment_method: 'cod', 'stripe', 'razorpay' or 'upi' (direct scan-and-pay QR)
-- ------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  reference        text not null unique,     -- human-facing code, e.g. PA-8F3K2
  name             text not null,
  email            text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text,
  address_line1    text not null,
  address_line2    text,
  city             text not null,
  state            text not null,
  pincode          text not null check (pincode ~ '^\d{6}$'),
  items            jsonb not null,           -- [{product_id, name, price_paise, qty}]
  subtotal_paise   integer not null check (subtotal_paise >= 0),
  shipping_paise   integer not null default 0 check (shipping_paise >= 0),
  total_paise      integer not null check (total_paise >= 0),
  payment_method   text not null check (payment_method in ('cod','stripe','razorpay','upi')),
  payment_status   text not null default 'pending'
                   check (payment_status in ('pending','paid','failed','refunded')),
  stripe_session_id text,   -- Stripe session id, or Razorpay order id for 'razorpay'
  status           text not null default 'new'
                   check (status in ('new','confirmed','shipped','delivered','cancelled')),
  created_at       timestamptz not null default now()
);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

-- Widen payment_method to accept 'razorpay'.
-- `create table if not exists` never alters an existing table, so on a
-- database created before Razorpay existed the inline CHECK above still
-- rejects the new value (error 23514). Dropping and re-adding the constraint
-- makes re-running this file upgrade an older database in place.
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('cod','stripe','razorpay','upi'));

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.photo_submissions enable row level security;
alter table public.wishes            enable row level security;
alter table public.quiz_scores       enable row level security;
alter table public.merch_products    enable row level security;
alter table public.orders            enable row level security;
alter table public.admins            enable row level security;

-- --- admins: a user may read only their own row -----------------
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- --- photo submissions ------------------------------------------
drop policy if exists ps_insert on public.photo_submissions;
create policy ps_insert on public.photo_submissions
  for insert to anon, authenticated
  with check (status = 'pending');

-- the public photo wall: anyone may see APPROVED items only
 drop policy if exists ps_public_read on public.photo_submissions;
create policy ps_public_read on public.photo_submissions
  for select to anon, authenticated
  using (status = 'approved');

-- admins additionally see the pending/rejected queue
 drop policy if exists ps_admin_read on public.photo_submissions;
create policy ps_admin_read on public.photo_submissions
  for select to authenticated
  using (public.is_admin());

drop policy if exists ps_admin_update on public.photo_submissions;
create policy ps_admin_update on public.photo_submissions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists ps_admin_delete on public.photo_submissions;
create policy ps_admin_delete on public.photo_submissions
  for delete to authenticated
  using (public.is_admin());

-- --- wishes -----------------------------------------------------
drop policy if exists wishes_insert on public.wishes;
create policy wishes_insert on public.wishes
  for insert to anon, authenticated
  with check (status = 'pending');

-- anyone may read APPROVED wishes; admins may read all
drop policy if exists wishes_public_read on public.wishes;
create policy wishes_public_read on public.wishes
  for select to anon, authenticated
  using (status = 'approved' or public.is_admin());

drop policy if exists wishes_admin_update on public.wishes;
create policy wishes_admin_update on public.wishes
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists wishes_admin_delete on public.wishes;
create policy wishes_admin_delete on public.wishes
  for delete to authenticated
  using (public.is_admin());

-- --- quiz scores: anyone may add and read the board --------------
drop policy if exists qs_insert on public.quiz_scores;
create policy qs_insert on public.quiz_scores
  for insert to anon, authenticated
  with check (score <= total);

drop policy if exists qs_read on public.quiz_scores;
create policy qs_read on public.quiz_scores
  for select to anon, authenticated
  using (true);

drop policy if exists qs_admin_delete on public.quiz_scores;
create policy qs_admin_delete on public.quiz_scores
  for delete to authenticated
  using (public.is_admin());

-- --- merch products: public read of active items, admin writes ---
drop policy if exists mp_public_read on public.merch_products;
create policy mp_public_read on public.merch_products
  for select to anon, authenticated
  using (active or public.is_admin());

drop policy if exists mp_admin_insert on public.merch_products;
create policy mp_admin_insert on public.merch_products
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists mp_admin_update on public.merch_products;
create policy mp_admin_update on public.merch_products
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists mp_admin_delete on public.merch_products;
create policy mp_admin_delete on public.merch_products
  for delete to authenticated
  using (public.is_admin());

-- --- orders: admin read only. Inserts come from the service role,
--     which bypasses RLS, so no insert policy is granted to anon. ---
drop policy if exists orders_admin_read on public.orders;
create policy orders_admin_read on public.orders
  for select to authenticated
  using (public.is_admin());

drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_update on public.orders
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- STORAGE BUCKETS
--   submissions : private, fan uploads awaiting review
--   wall        : public,  approved fan photos
--   merch       : public,  product images
--   movies      : public,  the archive's film photographs
-- ============================================================
insert into storage.buckets (id, name, public)
values
  ('submissions', 'submissions', false),
  ('wall',        'wall',        true),
  ('merch',       'merch',       true),
  ('movies',      'movies',      true)
on conflict (id) do nothing;

-- anyone may upload a submission; only admins may read/list/delete them
drop policy if exists sub_insert on storage.objects;
create policy sub_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'submissions');

drop policy if exists sub_admin_read on storage.objects;
create policy sub_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

drop policy if exists sub_admin_all on storage.objects;
create policy sub_admin_all on storage.objects
  for update to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

drop policy if exists sub_admin_delete on storage.objects;
create policy sub_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

-- public buckets are world-readable
drop policy if exists public_buckets_read on storage.objects;
create policy public_buckets_read on storage.objects
  for select to anon, authenticated
  using (bucket_id in ('wall','merch','movies'));

-- admins may manage the public buckets' contents
drop policy if exists public_buckets_admin_write on storage.objects;
create policy public_buckets_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id in ('wall','merch','movies') and public.is_admin());

drop policy if exists public_buckets_admin_update on storage.objects;
create policy public_buckets_admin_update on storage.objects
  for update to authenticated
  using (bucket_id in ('wall','merch','movies') and public.is_admin());

drop policy if exists public_buckets_admin_delete on storage.objects;
create policy public_buckets_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id in ('wall','merch','movies') and public.is_admin());

-- ============================================================
-- SEED: a starter merch catalogue (edit prices/stock from the admin UI)
-- ============================================================
insert into public.merch_products (name, description, price_paise, image_path, sort_order)
select * from (values
  ('Archive T-shirt',   'Heavyweight black tee with the archive crest',      99900, 'tee.jpg',   1),
  ('Era Poster Set',    'Four archive prints, one per era',                  149900, 'poster.jpg',2),
  ('Embroidered Hoodie','Charcoal fleece with an embroidered crest',         299900, 'hoodie.jpg',3),
  ('Numbered Print',    'Museum-weight paper, hand-numbered',                249900, 'print.jpg', 4),
  ('Collectible Cards', 'One chapter card per era, five in a pack',          49900, 'cards.jpg', 5)
) as v(name, description, price_paise, image_path, sort_order)
where not exists (select 1 from public.merch_products);

-- ============================================================
-- 7. SECURITY HARDENING (mirrors supabase/migrations/20261025_security_hardening.sql)
--    Re-run safe. Applied here too so a brand-new database built from this
--    file has the same privileges as the migrated production database.
--    Full rationale + verification queries: see the migration file.
-- ============================================================

-- --- orders: provider-specific payment ids, length caps, privilege narrowing
alter table public.orders add column if not exists razorpay_order_id text;
create index if not exists orders_razorpay_order_id_idx
  on public.orders (razorpay_order_id) where razorpay_order_id is not null;
create index if not exists orders_stripe_session_id_idx
  on public.orders (stripe_session_id) where stripe_session_id is not null;

alter table public.orders drop constraint if exists orders_name_len;
alter table public.orders add constraint orders_name_len check (char_length(name) <= 80) not valid;
alter table public.orders drop constraint if exists orders_email_len;
alter table public.orders add constraint orders_email_len check (char_length(email) <= 254) not valid;
alter table public.orders drop constraint if exists orders_phone_len;
alter table public.orders add constraint orders_phone_len check (phone is null or char_length(phone) <= 20) not valid;
alter table public.orders drop constraint if exists orders_addr1_len;
alter table public.orders add constraint orders_addr1_len check (char_length(address_line1) <= 200) not valid;
alter table public.orders drop constraint if exists orders_addr2_len;
alter table public.orders add constraint orders_addr2_len check (address_line2 is null or char_length(address_line2) <= 200) not valid;
alter table public.orders drop constraint if exists orders_city_len;
alter table public.orders add constraint orders_city_len check (char_length(city) <= 80) not valid;
alter table public.orders drop constraint if exists orders_state_len;
alter table public.orders add constraint orders_state_len check (char_length(state) <= 80) not valid;

revoke all on public.orders from anon;
revoke update on public.orders from authenticated;
grant  update (status) on public.orders to authenticated;

-- --- photo submissions: no anon reads of PII, public-safe view instead
drop policy if exists ps_public_read on public.photo_submissions;
revoke select on public.photo_submissions from anon;
revoke insert on public.photo_submissions from anon, authenticated;
grant  insert (name, email, caption, storage_path)
      on public.photo_submissions to anon, authenticated;

create or replace view public.photo_wall as
  select id, name, caption, wall_path, created_at
  from public.photo_submissions
  where status = 'approved' and wall_path is not null;
grant select on public.photo_wall to anon, authenticated;

-- --- wishes: column-limited anonymous privileges
revoke insert on public.wishes from anon, authenticated;
grant  insert (name, message) on public.wishes to anon, authenticated;
revoke select on public.wishes from anon;
grant  select (id, name, message, created_at) on public.wishes to anon;
-- Second lock: anon has no UPDATE/DELETE on wishes (admins keep them,
-- gated by wishes_admin_update / _delete policies).
revoke update, delete on public.wishes from anon;

-- --- quiz: table checks, throttled validating RPC, no anon INSERT
alter table public.quiz_scores drop constraint if exists quiz_scores_score_le_total;
alter table public.quiz_scores add constraint quiz_scores_score_le_total check (score <= total) not valid;
alter table public.quiz_scores drop constraint if exists quiz_scores_total_max;
alter table public.quiz_scores add constraint quiz_scores_total_max check (total <= 100) not valid;

create table if not exists public.quiz_throttle (
  ip text primary key,
  last_at timestamptz not null default now(),
  day date not null default current_date,
  day_count integer not null default 0
);
alter table public.quiz_throttle enable row level security;
revoke all on public.quiz_throttle from anon, authenticated, public;

revoke insert, update, delete on public.quiz_scores from anon, authenticated;
revoke select on public.quiz_scores from anon;
grant  select (name, score, total, created_at) on public.quiz_scores to anon;
-- Admins moderate the leaderboard; qs_admin_delete gates the DELETE to
-- is_admin(). Insert stays revoked: submit_quiz_score RPC is the write path.
grant  delete on public.quiz_scores to authenticated;

-- (submit_quiz_score / rate_limit_hit / reserve_stock / restore_stock are
--  created below — identical definitions to the migration file.)

-- --- merch: anon reads public catalogue columns only
revoke select on public.merch_products from anon;
grant  select (id, name, description, price_paise, image_path, active, stock, sort_order)
      on public.merch_products to anon;

-- --- admins: nothing for anon
revoke all on public.admins from anon;

-- --- storage: size/MIME limits + upload filename policy
update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'submissions';
update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id in ('wall', 'merch');

drop policy if exists sub_insert on storage.objects;
create policy sub_insert on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'submissions'
    and char_length(name) between 1 and 140
    and name !~ '\.\.'
    and lower(name) ~ '\.(jpg|jpeg|png|webp)$'
  );

-- --- persistent rate limiter
create table if not exists public.rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket, key, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated, public;

-- --- atomic inventory + rate limit + quiz functions
--     (defined exactly as in the migration; `create or replace` is idempotent)

create or replace function public.submit_quiz_score(p_name text, p_score int, p_total int)
returns setof public.quiz_scores
language plpgsql security definer set search_path = public
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

create or replace function public.rate_limit_hit(p_bucket text, p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_win timestamptz;
  v_hits integer;
begin
  if p_bucket is null or p_key is null or p_max is null or p_max <= 0 then
    return true;
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
  if random() < 0.02 then
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

create or replace function public.reserve_stock(p_product_id uuid, p_qty integer)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if p_qty is null or p_qty < 1 then return 'invalid'; end if;
  update public.merch_products
     set stock = stock - p_qty
   where id = p_product_id and stock is not null and stock >= p_qty;
  if found then return 'ok'; end if;
  if exists (select 1 from public.merch_products
              where id = p_product_id and active and stock is null) then
    return 'ok';
  end if;
  return 'insufficient';
end;
$$;

create or replace function public.restore_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql security definer set search_path = public
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
