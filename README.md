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

```bash
cd backend
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
