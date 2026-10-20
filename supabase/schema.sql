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
--    payment_method: 'cod' or 'stripe'
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
  payment_method   text not null check (payment_method in ('cod','stripe')),
  payment_status   text not null default 'pending'
                   check (payment_status in ('pending','paid','failed','refunded')),
  stripe_session_id text,
  status           text not null default 'new'
                   check (status in ('new','confirmed','shipped','delivered','cancelled')),
  created_at       timestamptz not null default now()
);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

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
