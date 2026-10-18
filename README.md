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

## Running locally

### 1. Database

Create a Postgres database, then point the backend at it:

```bash
cd backend
cp .env.example .env
# edit .env: DATABASE_URL, STRIPE_SECRET_KEY, etc.
```

### 2. Backend

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
npm run migrate   # applies backend/src/db/migrations/*.sql
npm run dev        # starts the API on http://localhost:4000
```

### 3. Frontend

The frontend is static files — no build step. Serve the `frontend/`
folder with any static server, e.g.:

```bash
cd frontend
npx serve .
# or: python3 -m http.server 5500
```

By default `frontend/js/api.js` calls a same-origin `/api`. If you're
serving the frontend separately from the backend (as above), set
`window.API_BASE_URL` before `api.js` loads — e.g. add this to each page's
`<head>`:

```html
<script>window.API_BASE_URL = "http://localhost:4000/api";</script>
```

Make sure `FRONTEND_ORIGIN` in `backend/.env` matches wherever you're
serving the frontend from, so CORS allows it.

The storefront is `index.html` (hero, the studio where standees are
designed, how it works, gallery), plus `checkout.html` (cart →
Stripe). See `docs/frontend-guide.md`.

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
  "4.9/5 from 12,000+" rating, "48 hours", "AI removes the background"
  (not built), the guarantee, and the four gallery quotes. **The rating
  and quotes are invented.** Replace them with real, permissioned ones, or
  remove them, before taking real customers.
- `frontend/img/*.svg` are generated illustrations. Replace them with real
  photos (and update the `src`).

### 4. Admin page

Open `frontend/admin.html` (it isn't linked from the site nav). Enter
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
under 32 characters), `HOST=127.0.0.1`, `TRUST_PROXY=loopback`, and
`PUBLIC_API_URL=https://<your domain>`.

Put Caddy in front for HTTPS. It gets certificates automatically and
forwards `X-Forwarded-For`/`X-Forwarded-Proto` by default:

```
yourdomain.com {
  handle /api/* {
    reverse_proxy 127.0.0.1:4000
  }
  handle {
    root * /path/to/cutout-website/frontend
    file_server
  }
}
```

Admin requests that don't arrive over HTTPS are refused in production.

### 5. Stripe webhook (local testing)

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
