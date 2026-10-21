# Cutout Website

A website for ordering custom life-size 2D cutouts: upload a photo, pick
size/material/quantity, pay with Stripe, and the order gets forwarded to a
manufacturing supplier for production and shipping.

See `CLAUDE.md` and `docs/` for the full spec — this README is just the
"how do I run it" version.

## Stack

- **Frontend:** plain HTML/CSS/vanilla JS — `frontend/`. No build step.
- **Backend:** Express (Node.js) — `backend/`. Flat routes → services → db.
- **Database:** PostgreSQL.
- **Payments:** Stripe Checkout.
- **Background removal:** in the customer's browser, with
  [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.0
  and the MODNet model (`Xenova/modnet`). Both are Apache-2.0, so
  commercial use is fine. The library loads from `cdn.jsdelivr.net` and the
  model (~6.6 MB, cached after the first photo) from Hugging Face
  (`huggingface.co`, `*.hf.co`). Photos aren't sent to either; only the
  code and model are downloaded. To avoid third parties entirely,
  self-host both under `frontend/`, point `TRANSFORMERS_URL` and the model
  path in `frontend/js/background-removal.js` at them, and remove those
  hosts from the CSP in `backend/src/security.js`.

## Configuration and secrets

- **Backend:** every setting comes from `backend/.env` (copy
  `.env.example`; `.env` is gitignored) and is read in one place,
  `backend/src/config.js`. That includes Stripe and AWS keys, the admin
  token and the link-signing secret.
- **Frontend:** non-secret values (the API path `/api`, CDN URLs,
  storefront text) are in `frontend/js/site-config.js`. Nothing in
  `frontend/` can be secret, because the browser downloads all of it. The
  site and API share one origin, so no backend hostname appears in the
  frontend.

## Running locally

### 1. Database

Create a Postgres database, then point the backend at it:

```bash
cd backend
cp .env.example .env
# edit .env: DATABASE_URL, STRIPE_SECRET_KEY, etc.
```

### 2. Start the site (backend + frontend, one port)

The Express backend serves both the API (`/api/...`) and the static site
(`frontend/`), so there's one process, one port, no CORS and no frontend
build step.

Needs Node ≥ 20.9 (for `sharp`). `backend/.nvmrc` pins 22, so `nvm use`
works.

No AWS needed locally: uploads are stored in `backend/storage/uploads/`
(gitignored) because `STORAGE_DRIVER` defaults to `disk`, and emails are
logged to the console. Use `STORAGE_DRIVER=s3` with `S3_BUCKET` in
production.

```bash
cd backend
nvm use
npm install
npm run migrate   # applies backend/src/db/migrations/*.sql (safe to re-run)
npm run dev       # restarts on backend changes; `npm start` doesn't
```

Then open **http://localhost:4000**.

| Page | URL |
|---|---|
| Storefront + studio | http://localhost:4000/ (studio: `/#studio`) |
| Cart & checkout | http://localhost:4000/checkout |
| Pricing | http://localhost:4000/pricing |
| Returns policy | http://localhost:4000/policies |
| Order status | http://localhost:4000/order-status |
| Admin (not linked in the nav) | http://localhost:4000/admin |

Clean URLs and the `.html` versions both work. Frontend files are served
fresh on every request, so after editing HTML/CSS/JS just refresh the
browser. Backend changes need a restart (automatic with `npm run dev`).

After paying, Stripe returns the customer to `/order-status?order=…`, or to
`/checkout` if they cancel. These are built from `SITE_URL`, which
defaults to `http://localhost:4000`. No `FRONTEND_ORIGIN` / CORS setting is
needed, since everything is on one origin.

See `docs/frontend-guide.md` for the pages.

#### Before launch: replace the placeholders

- **Stripe:** use a Stripe account that settles in **CAD**, and turn on
  **Adaptive Pricing** (Dashboard → Settings → Payments) so customers outside
  Canada see their local currency.
- **Returns policy** (`frontend/policies.html`): all sales are final, with a
  free reprint if damaged or misprinted. Set `supportEmail` in
  `site-config.js`, and have the wording reviewed against consumer-protection
  rules for the provinces/states you sell to.

The design was built with values that aren't real yet. All of them are in
two places:

- `frontend/js/site-config.js`: delivery and production days, the "from"
  price, the rating, and the material catalogue.
- Comments marked `PLACEHOLDER` in `frontend/index.html`: the
  "4.9/5 from 12,000+" rating, "48 hours", the guarantee, and the four gallery quotes. **The rating
  and quotes are invented.** Replace them with real, permissioned ones, or
  remove them, before taking real customers.
- `frontend/img/*.svg` are generated illustrations. Replace them with real
  photos (and update the `src`).

### Run the tests

```bash
cd backend && npm test
```

The tests never touch your dev database. By default they use a throwaway
in-memory one. To run them against real Postgres, create a **separate**
test database (as a Postgres user that can create databases) and point
`TEST_DATABASE_URL` at it in `backend/.env.test` (git-ignored):

```bash
createdb cutout_website_test
echo 'TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/cutout_website_test' > backend/.env.test
```

The suite refuses any database whose name doesn't end in `_test`.

**Security settings** (all in `backend/.env.example`):
- `TRUST_PROXY` is the number of proxies in front: 0 locally, 1 behind Caddy.
- `CLIENT_IP_HEADER` is only for when Cloudflare is in front (e.g.
  `cf-connecting-ip`); leave it unset otherwise.
- `UPLOAD_MAX_MB` defaults to 18, the most that can still be emailed to the
  printer.
- The admin page sends `ADMIN_TOKEN` as `Authorization: Bearer`.

### 3. Admin page

Open http://localhost:4000/admin (it isn't linked from the site nav). Enter
your name and `ADMIN_TOKEN` from `backend/.env` (dev default:
`dev-admin-token`). Both are kept only for that browser tab. From there
you can see orders, download each order's photo, generate fresh expiring
links for the supplier, and change an order's status. Every status change
is recorded in the order's history with your name and IP.

### Deploying (production checklist)

```bash
openssl rand -base64 48   # → ADMIN_TOKEN
openssl rand -base64 48   # → FILE_LINK_SECRET (a different value)
```

In `backend/.env` on the server: `NODE_ENV=production`, both secrets above
(the server refuses to start if either is missing, a dev default, or
under 32 characters), `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, `HOST=127.0.0.1`,
`TRUST_PROXY=1` (one proxy, Caddy, in front; it sets which IP the rate
limits see), and
`SITE_URL=https://<your domain>`, and `FULFILLMENT_EMAIL` (the server
refuses to start in production without these two, or without the secrets).

Put Caddy in front for HTTPS. It gets certificates automatically and
forwards `X-Forwarded-For`/`X-Forwarded-Proto` by default. Express serves
both the site and the API, so everything goes to the one app:

```
yourdomain.com {
  reverse_proxy 127.0.0.1:4000
}
```

Admin requests that don't arrive over HTTPS are refused in production.

### 4. Stripe webhook (local testing)

Use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward events
to your local backend:

```bash
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

Copy the webhook signing secret it prints into `STRIPE_WEBHOOK_SECRET` in
`backend/.env`.

## Project layout

```
cutout-website/
├── CLAUDE.md              — entry point for AI-assisted work on this repo
├── docs/                  — architecture, frontend/backend guides, schema, API spec
├── frontend/              — static HTML/CSS/vanilla JS site
└── backend/               — Express API
```
# cutout-website
