# Backend Guide

Read `architecture.md` first. This doc governs everything under `backend/`.

## Philosophy

Flat and boring on purpose: **routes → services → db**. No DTOs, no
validator classes, no repository layer, no domain models. Light
validation lives inline, in the route or in the service function that
owns the data (e.g. `validateOrderInput` in `services/orders.js`). It
doesn't need its own file at this size.

## Folder structure

```
backend/
├── package.json
├── .env.example               — every env var, with working dev defaults
├── .nvmrc                     — Node 22 (sharp needs ≥ 20.9)
├── storage/uploads/           — uploaded images when STORAGE_DRIVER=disk
│                                (gitignored, never served statically)
└── src/
    ├── server.js              — startup secret checks, trust proxy, CORS,
    │                             mounts routes, listens on HOST:PORT
    ├── routes/
    │   ├── _respond.js         — ok()/fail(): the { data, error } envelope +
    │   │                         error code → HTTP status map
    │   ├── pricing.js          — GET /pricing-config
    │   ├── orders.js           — POST /uploads, POST /orders,
    │   │                         POST /orders/:id/checkout-session,
    │   │                         GET /orders/:id?email=
    │   ├── webhooks.js         — POST /webhooks/stripe
    │   ├── files.js            — GET /files/:key (expiring signed image downloads)
    │   └── admin.js            — X-Admin-Token gate + failed-attempt limit;
    │                             GET /admin/orders[/:id],
    │                             POST /admin/orders/:id/download-links,
    │                             PATCH /admin/orders/:id/status
    ├── services/
    │   ├── pricing.js          — sizeTierForHeight, getPricingConfig,
    │   │                         calculatePrice, calculateShipping
    │   │                         (authoritative; mirrored in
    │   │                         frontend/js/pricing.js)
    │   ├── orders.js           — createOrder, getOrderById, setStripeSession,
    │   │                         markOrderPaid, updateOrderStatus,
    │   │                         getStatusEvents, listOrders (uses the db
    │   │                         pool directly; no repository layer)
    │   ├── stripe.js           — createCheckoutSession, constructWebhookEvent
    │   ├── uploads.js          — processUpload: validate, auto-rotate, store
    │   ├── storage.js          — disk/s3 driver + signed download links
    │   └── email.js            — sendFulfillmentEmail, sendCustomerConfirmation,
    │                             sendShippedNotification (SES, or console in dev)
    └── db/
        ├── pool.js             — pg Pool from DATABASE_URL
        ├── migrate.js          — `npm run migrate`: applies every .sql in
        │                         filename order, one transaction per file
        └── migrations/
            ├── 001_init.sql    — core tables + seeds pricing_config /
            │                     quantity_discount_tiers
            ├── 002_shipping.sql — shipping_rates (seeded) + orders.shipping_amount
            ├── 003_image_key.sql — order_items.image_url → image_key
            ├── 004_order_status_events.sql — status-change audit log
            ├── 005_item_customization.sql — order_items.width_in + text_elements
            └── 006_cad_and_final_sale.sql — currency, final-sale acceptance, USD→CAD seeds
```

`migrate.js` re-runs **every** file each time, so migrations must be
idempotent. See `database-schema.md`.

## Request lifecycle (example: placing an order)

```
POST /api/uploads (multipart "image")
  → routes/orders.js: multer parses into memory (size cap)
      → services/uploads.js: processUpload → validate, rotate, re-encode
      → services/storage.js: saveFile(<uuid>.<ext>)
      → 201 { imageKey, width, height }

POST /api/orders
  → routes/orders.js: hands req.body to the service
      → services/orders.js: createOrder
          validateOrderInput   (email, phone, address, country, material,
                                quantity, heightIn 12–96, widthIn 6–96,
                                textElements, imageKey format)
          storage.fileExists   (each imageKey must really be stored)
          per item: tier = pricing.sizeTierForHeight(heightIn)
                    pricing.calculatePrice + pricing.calculateShipping
          one transaction: INSERT orders + order_items
      → 201 with the full order (incl. server-computed totals)

POST /api/orders/:id/checkout-session
  → must be pending_payment → stripe.createCheckoutSession(stored totalPrice)

POST /api/webhooks/stripe  (checkout.session.completed)
  → orders.markOrderPaid: status + audit event + payment row, one statement
  → email.sendFulfillmentEmail + sendCustomerConfirmation
```

No class hierarchies, no dependency injection. A service file is just a
module exporting a few `async function`s that take plain arguments and
return plain objects. Services signal expected failures by throwing an
`Error` with a `code` (`VALIDATION_ERROR`, `NOT_FOUND`, …), and the
route's `fail()` maps that to an HTTP status.

## Response shape

Keep it simple and consistent (`routes/_respond.js`):

```json
{ "data": { ... }, "error": null }
```

or on failure:

```json
{ "data": null, "error": { "message": "...", "code": "VALIDATION_ERROR" } }
```

| `code` | HTTP |
|---|---|
| `VALIDATION_ERROR` | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `RATE_LIMITED` | 429 |
| anything else → `INTERNAL_ERROR` | 500 (logged) |

Malformed order IDs are caught in `services/orders.js` (`assertOrderId`)
and become 404s. They never reach Postgres as a type error (a 500).

## Pricing service (critical: must match the frontend's copy)

`services/pricing.js` owns `sizeTierForHeight(...)`, `calculatePrice(...)`
and `calculateShipping(...)`. These are the **authoritative** versions;
`frontend/js/pricing.js` exists only for live UI feedback. If the formula
changes, update both, and keep both deriving from the same config data
(`pricing_config`, `quantity_discount_tiers` and `shipping_rates`, all
served by `GET /api/pricing-config`).

Order of operations, per item:

0. `size_tier = sizeTierForHeight(height_in)`: ≤ 36" small, ≤ 60" medium,
   ≤ 78" life-size, otherwise XL. The customer picks a height in the
   studio, never a tier, and any tier sent by the client is ignored.
1. Look up `base_rate` for `(size_tier, material)` in `pricing_config`.
2. Look up `discount_pct` for the quantity in `quantity_discount_tiers`
   (the row whose `[min_qty, max_qty]` range contains it).
3. `unit_price = round2(base_rate * (1 - discount_pct / 100))`
4. `line_total = round2(unit_price * quantity)`, and
   `subtotal = round2(base_rate * quantity)`
5. `calculateShipping`: look up `(country, size_tier)` in
   `shipping_rates`, then
   `shipping = round2(first_unit_rate + additional_unit_rate * (quantity - 1))`.
   The quantity discount never applies to shipping.

Order totals:
- `subtotal` = sum of the item subtotals
- `discount_amount` = `subtotal - sum(line_total)`
- `shipping_amount` = sum of the item shipping
- `total_price` = `sum(line_total) + shipping_amount`

All are rounded to 2 decimals and stored separately for auditability.

**When it runs:** once, server-side, in `createOrder`. Client-sent prices
are never read. The checkout session then charges the **stored**
`total_price`, so the amount the customer pays is exactly what was saved
on the order.

## Currency

Everything is **CAD**: `CURRENCY` in `services/pricing.js` is the single
source. It's returned by `/api/pricing-config`, stored on each order
(`orders.currency`), and used for the Stripe charge. To show local
currencies to customers outside Canada, turn on **Adaptive Pricing** in the
Stripe Dashboard (Settings → Payments). That needs no code, and Stripe still
settles in CAD.

## Final-sale policy

Every standee is custom-made, so all sales are final (free reprint if it
arrives damaged or misprinted; see `frontend/policies.html`).
`createOrder` rejects orders without `acceptedFinalSale: true` and records
`final_sale_accepted_at` + `POLICY_VERSION` (`services/orders.js`; bump it,
and `SITE.policyVersion`, when the policy text changes materially). The
Stripe page repeats the notice via `custom_text.submit`, and the customer
confirmation email includes it.

## Stripe integration

- `services/stripe.js` creates the Checkout Session from the stored
  `totalPrice`: the order's currency (CAD), one line item,
  `metadata.orderId`, plus the final-sale `custom_text`.
  `STRIPE_SUCCESS_URL` has `{ORDER_ID}` substituted.
- The checkout-session route refuses orders that aren't `pending_payment`,
  so a paid order can't be charged twice.
- `POST /api/webhooks/stripe` (raw body, signature-verified via
  `constructWebhookEvent`) is the only route that can mark an order `paid`.
  Never trust the client redirect.
- On `checkout.session.completed`, the webhook route:
  - calls `ordersService.markOrderPaid(id, paymentIntentId, { amount, rawPayload })`.
    In one SQL statement it flips the status, writes the audit event and
    writes the `payments` row, only if the order was still
    `pending_payment`, so retries are no-ops.
  - **then** sends the fulfillment and customer emails itself, and warns
    if Stripe's `amount_total` differs from the order total.

## Image uploads & storage

- `POST /api/uploads` (multer, in memory) → `uploads.processUpload`. It
  checks the type (by contents, via `sharp`), size and minimum resolution,
  bakes in the EXIF rotation, strips EXIF/GPS (keeping the colour profile),
  and saves under a random key. Orders store only that key
  (`order_items.image_key`).
- `services/storage.js` is the **only** file that knows where images
  live: `STORAGE_DRIVER=disk` (default: `backend/storage/uploads/`) or
  `s3` (production: private `S3_BUCKET`, under `uploads/`). Nothing else
  should touch `fs` or S3 for images. `isValidKey` (`<uuid>.<jpg|png|webp>`)
  is checked before any file access, so path traversal is impossible.
- The supplier gets images through `createDownloadUrl(key)`: our own
  HMAC-signed `GET /api/files/:key` link, valid for
  `DOWNLOAD_LINK_TTL_DAYS` (default 30). We don't use S3 presigned links
  directly because S3 caps them at 7 days. In s3 mode the route redirects
  to a 5-minute presigned GET. `PUBLIC_API_URL` must be the backend's
  public address, or the links in emails won't work.
- Known gaps: uploads that never become orders aren't cleaned up, and
  there's no rate limit on `POST /api/uploads` yet.

## Admin access & deployment

- `/api/admin/*` is gated by one shared secret (`ADMIN_TOKEN`) in the
  `X-Admin-Token` header, with a per-IP failed-attempt limit (10 per 15
  minutes, in memory). Details are in `api-spec.md`. All of it lives in
  `routes/admin.js`, so there's no auth framework to maintain.
- `server.js` refuses to start in production if `ADMIN_TOKEN` or
  `FILE_LINK_SECRET` is missing, a dev default, or under 32 characters.
  In dev it only warns.
- Production runs behind **Caddy**, which terminates HTTPS:
  - `HOST=127.0.0.1`: the app only listens on localhost, so nobody can
    bypass Caddy and talk plain HTTP to port 4000.
  - `TRUST_PROXY` (default `loopback`): which proxy's `X-Forwarded-For` /
    `X-Forwarded-Proto` to believe. That gives the rate limit and audit log
    the real client IP, and lets `req.secure` work. Never set it to `true`
    on a server reachable directly from the internet, because clients
    could then spoof their IP.
  - With `NODE_ENV=production`, admin requests that didn't come over
    HTTPS are refused (403).

## Email (SES)

`services/email.js` wraps SES. If `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` or `SES_FROM_EMAIL` is missing (typical in local
dev), it `console.log`s what would have been sent instead of throwing.

| Function | To | Contains |
|---|---|---|
| `sendFulfillmentEmail` | `FULFILLMENT_EMAIL` (skipped with a warning if unset) | full order details, shipping and total; per item the size, width, text elements and an expiring **image download link**; you forward it to the supplier |
| `sendCustomerConfirmation` | the customer | the same order details, **without** download links |
| `sendShippedNotification` | the customer | sent when the status changes to `shipped` |

## Environment variables

All are in `backend/.env.example` with working dev defaults, except
`NODE_ENV`, which is unset in dev. Set it to `production` on the server.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | (unset) | `production` turns on the secret checks and the admin HTTPS requirement |
| `PORT` | `4000` | listen port |
| `HOST` | `0.0.0.0` | listen address; `127.0.0.1` in production (behind Caddy) |
| `TRUST_PROXY` | `loopback` | Express `trust proxy`; `true`/`false`/hop count/subnets also accepted |
| `FRONTEND_ORIGIN` | `*` | CORS origin, when the frontend is served from another origin |
| `DATABASE_URL` | (none) | Postgres connection string |
| `STRIPE_SECRET_KEY` | (none) | required for checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | (none) | verifies webhook signatures |
| `STRIPE_SUCCESS_URL` | (none) | redirect after payment; `{ORDER_ID}` is substituted |
| `STRIPE_CANCEL_URL` | (none) | redirect if the customer cancels |
| `STORAGE_DRIVER` | `disk` | `disk` or `s3` |
| `UPLOAD_DIR` | `./storage/uploads` | disk driver location, relative to `backend/` |
| `S3_BUCKET` | (none) | s3 driver bucket (private) |
| `AWS_REGION` | `us-east-1` | S3 and SES region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (none) | AWS credentials; without them email logs to the console |
| `UPLOAD_MAX_MB` | `25` | upload size cap |
| `UPLOAD_MIN_LONG_EDGE_PX` | `2000` | minimum long edge, after rotation |
| `PUBLIC_API_URL` | `http://localhost:4000` | base URL used in download links |
| `FILE_LINK_SECRET` | dev default | HMAC key for download links (32+ characters in production) |
| `DOWNLOAD_LINK_TTL_DAYS` | `30` | download link lifetime |
| `ADMIN_TOKEN` | dev default | admin shared secret (32+ characters in production) |
| `FULFILLMENT_EMAIL` | (none) | where paid-order emails go |
| `SES_FROM_EMAIL` | (none) | SES sender address |
