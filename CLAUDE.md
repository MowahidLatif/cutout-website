# Cutout Website — Project Context for Claude Code

Read this first, then read the relevant doc in `docs/` before writing code.

## What this project is

A website where customers upload a photo, choose a size, material, and
quantity, and order a life-size 2D cutout. Orders are paid via Stripe, then
manually forwarded (by email, for now) to a Chinese manufacturing contact
who produces and ships the product directly to the customer.

## Stack (kept deliberately simple)

- **Frontend: plain HTML, CSS, and vanilla JS. No React, no build step, no
  framework.** Each page is its own `.html` file with shared `css/style.css`
  and small page-specific JS files. The Express backend serves `frontend/`
  on the same port as the API: run `npm run dev` in `backend/` and open
  http://localhost:4000 (clean URLs like `/pricing` work). No
  `npm run build` for the frontend, and no CORS or API base URL.
  Storefront copy that isn't real yet (rating, quotes, turnaround, "from"
  price) is marked `PLACEHOLDER` in `index.html` or lives in
  `frontend/js/site-config.js`. Keep new unknowns there, never in prices.
- **Backend: Express (Node.js), flat structure — routes → services → db.**
  No DTO/validator/repository ceremony. A route handler parses the request,
  calls a service function, returns JSON. Keep it boring and readable.
- **Database: PostgreSQL.**
- **Payments: Stripe Checkout** (hosted page — no custom card form).
- **Cloud: AWS** — S3 for uploaded images in production (local disk in dev
  via `STORAGE_DRIVER=disk`; see `backend/src/services/storage.js`), RDS
  for Postgres, SES for email (SES calls are stubbed/logged in dev; see
  `backend/src/services/email.js`). The whole order flow runs locally
  without AWS credentials.

## Before you write code, read the matching doc

| Task | Read this first |
|---|---|
| Anything in `frontend/` | `docs/frontend-guide.md` |
| Anything in `backend/` | `docs/backend-guide.md` |
| Database tables, migrations, enums | `docs/database-schema.md` |
| API routes / request-response shapes | `docs/api-spec.md` |
| High-level flow, what's deliberately not built yet | `docs/architecture.md` |

## V1 scope guardrails

- **No user accounts / auth.** Guest checkout only. Email + phone are
  captured once, at order time.
- **No AI height detection.** Height is a manual number input.
- **No automated supplier integration.** Fulfillment is a manual email sent
  via SES when an order is paid; a human forwards it to the supplier.
- **No background removal / image processing pipeline yet.** Uploads are
  normalized: any photo (JPEG/PNG/WebP/GIF/TIFF/AVIF/HEIC) or PDF (page 1
  rendered) is accepted, auto-rotated from EXIF, and given a print-quality
  rating. There's no minimum resolution; low quality needs the customer's
  confirmation. No other edits (no background removal).
- **All prices and charges are CAD** (`CURRENCY` in
  `backend/src/services/pricing.js`). **All sales are final** (custom-made;
  free reprint if damaged), and checkout requires accepting that.
- **Order limits:** up to 500 cutouts and 10 different photos per order,
  enforced in the studio, checkout and server. Bulk discount is per design;
  shipping is priced per order (one first-unit charge).
- **Pricing is config-driven, not hardcoded**: size tier × material
  multiplier, with a quantity-discount curve. Both live in the database so
  they can change without a redeploy.
- **Price is calculated live in the browser for instant UX, but always
  recalculated server-side before a Stripe session is created.** Never
  trust a price sent from the client — the frontend's copy of the formula
  (`frontend/js/pricing.js`) exists only to make the form feel responsive.
- **Keep both halves simple.** If a change adds a new abstraction layer,
  config system, or framework, stop and check it's actually needed before
  adding it — the whole point of this stack choice is to stay light.
