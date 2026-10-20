# Prabhas — The Fan Archive

An independent, fan-run archive of Prabhas's filmography — 26 films, verified
records, a fan quiz, a moderated photo wall, a birthday countdown and a small
merch shop. A single-file archive site rebuilt as a deployable full-stack
project: static frontend, Supabase backend, Vercel serverless functions.

**Live:** [prabhas-fan-archive.vercel.app](https://prabhas-fan-archive.vercel.app)
· **Owner dashboard:** [/admin](https://prabhas-fan-archive.vercel.app/admin)

> Not affiliated with Prabhas, his management, production companies or film
> studios. Photographs are shown for fan commentary; all rights remain with
> their owners.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Single static page, hash router, no framework | The archive's motion design stays exactly as authored; nothing to hydrate |
| Database + auth + storage | Supabase | Postgres with row-level security, GoTrue auth and Storage in one project |
| Compute | Vercel Node serverless functions | Sits next to the static assets, zero build step |
| Email | Resend | Plain REST, no SDK, generous free tier |
| Payments | Stripe Checkout + cash on delivery | Card/UPI for those who want it, COD for the rest of India |

**Zero npm dependencies at runtime.** Supabase, Stripe and Resend are each
called over their plain REST APIs with Node's built-in `fetch`, and the Stripe
webhook signature is checked with `node:crypto`. `vercel` is a dev-only CLI.

---

## Architecture

```
public/            static site (Vercel serves this verbatim)
  index.html       the archive — routes, filmography data, quiz, gallery
  backend.js       photo wall, wishes, leaderboard, cart, order form
  admin/           owner dashboard (moderation, orders, products)
  config.js        GENERATED at build — carries only the public anon key
  images/          81 film photographs, 24 of 26 films

api/               Vercel serverless functions (Node 24)
  orders.js            create an order — prices re-read from the database
  stripe-webhook.js    flip an order to paid on Stripe confirmation
  moderate.js          approve/reject a submission, moving the storage file
  _lib.js              Supabase REST, Resend, storage helpers

supabase/schema.sql    tables, RLS policies, storage buckets, seed catalogue
scripts/               config generation, checks, tests, image tooling
```

### Request flow — placing an order

1. The browser sends **only product ids and quantities** — never a price.
2. `api/orders.js` re-reads each product from Postgres and recomputes the
   subtotal, shipping and total. A tampered client cannot set its own price.
3. For COD the order is stored and the owner is emailed immediately.
   For card/UPI a Stripe Checkout Session is created and the browser is
   redirected; `api/stripe-webhook.js` verifies the HMAC over the **raw** body
   and flips the order to `paid`, then emails buyer and owner.

### Security model

Row-level security is the boundary, not the serverless functions. Anonymous
clients can only:

- read **approved** photo submissions and wishes (never the pending queue),
- read **active** merch products,
- insert new submissions, wishes and quiz scores (always as `pending`),
- never touch `orders` — inserts come exclusively from the service role,
- never write to any table.

Verified in this project: an anonymous `PATCH` to a product price affects zero
rows, and an anonymous `INSERT` into `orders` is refused.

Secrets live only in Vercel environment variables. `public/config.js` is
generated at build time and carries the URL and the anon key, both of which are
public by design and guarded by the policies above. The service-role key never
reaches the browser.

---

## Local development

```bash
npm install
cp .env.example .env.local      # fill in your keys
npm run config                  # generates public/config.js
npm run serve                   # http://127.0.0.1:8123
```

`/api/*` only runs on Vercel, so use `npx vercel dev` to exercise the order
endpoint locally. The static server answers `501` there on purpose, so the
UI's error paths can be seen.

### Checks

```bash
npm run check   # syntax across every JS file, JSON config and inline script
npm test        # 13 assertions on the order endpoint
```

The order tests mock Supabase and assert that client-supplied prices are
ignored, stock limits are enforced, shipping thresholds apply, references match
`PA-XXXXX`, and Stripe degrades to a friendly message when unconfigured.

---

## Deployment

1. **Supabase** — create a project, open the SQL editor, run
   `supabase/schema.sql`. It is idempotent: tables, every RLS policy, four
   storage buckets (`submissions` private; `wall`, `merch`, `movies` public)
   and a five-product starter catalogue.
2. **Vercel** — import the GitHub repository. The build command
   (`node scripts/build-config.mjs`) and output directory (`public`) are
   already in `vercel.json`. Once the project is Git-connected with `main` as
   the production branch, every push to `main` builds and deploys itself, so
   there is no separate deploy step to forget.
3. **Environment variables** — set every name from `.env.example`. With a
   Vercel token in scope, `node scripts/set-vercel-env.mjs` pushes them all,
   marking the four secrets as sensitive so Vercel never returns their values.
   `SITE_URL` is the stable production alias; without it the functions fall
   back to `VERCEL_URL`, so nothing breaks before the first deploy.
4. **Stripe** — add a webhook pointing at `/api/stripe-webhook` with events
   `checkout.session.completed`, and put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. Registering it over the API returns that secret in
   the response, which is the least error-prone way to obtain it.
5. **Owner account** — visit `/admin/`, create the owner account, confirm it in
   Supabase → Authentication, then insert your user id into `public.admins`.

### Image tooling

| Script | Purpose |
| --- | --- |
| `npm run wire-images` | Map local image folders onto the filmography's slug paths |
| `node scripts/upload-merch-images.mjs` | Upload the archive's decorative merch images to Storage |

---

## Roadmap

- [ ] Kannappa and *Baahubali: The Epic* are missing photographs — no folders
      were supplied for them, so they render the designed fallback card.
- [ ] Product photography for the merch catalogue.
- [ ] Verified box-office and awards data for the remaining films.

## Licence

Fan project, non-commercial. Film data sourced from Wikipedia and cited
publications; corrections welcome.
