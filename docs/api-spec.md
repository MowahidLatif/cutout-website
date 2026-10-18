# API Spec (v1)

Base path: `/api`. All responses use the `{ data, error }` envelope
described in `backend-guide.md`.

## Public endpoints

### `GET /pricing-config`
Returns current `pricing_config` rows, `quantity_discount_tiers` and
`shipping_rates`, so both `pricing.html` and `create.html` can compute
prices without hardcoding rates.

```json
{
  "data": {
    "rates": [
      { "sizeTier": "life_size", "material": "coroplast", "baseRate": 45.00 }
    ],
    "discountTiers": [
      { "minQty": 2, "maxQty": 4, "discountPct": 5 }
    ],
    "shippingRates": [
      { "country": "CA", "sizeTier": "life_size", "firstUnitRate": 122.00, "additionalUnitRate": 60.00 }
    ]
  },
  "error": null
}
```

### `POST /orders`
Creates an order in `pending_payment` status. Recomputes price server-side
from the submitted size/material/quantity — ignores any price field sent
by the client.

Request:
```json
{
  "customerEmail": "jane@example.com",
  "customerPhone": "+1-204-555-0100",
  "shippingAddress": { "line1": "...", "city": "...", "region": "...", "postalCode": "...", "country": "CA" },
  "items": [
    {
      "imageKey": "3f2b7c1e-8d4a-4f6b-9c2e-1a5d7e9f0b3c.jpg",
      "sizeTier": "life_size",
      "material": "coroplast",
      "heightIn": 68,
      "quantity": 3
    }
  ]
}
```

`shippingAddress.country` must be `CA` or `US`. Anything else is a
`VALIDATION_ERROR`. Each `imageKey` must come from `POST /uploads` and
the file must actually exist in storage, otherwise `VALIDATION_ERROR`.

Response: the created order, including server-computed `subtotal`,
`discountAmount`, `shippingAmount`, `totalPrice` (which includes shipping),
and its `id`.

### `POST /orders/:id/checkout-session`
Creates a Stripe Checkout Session for an existing `pending_payment` order,
using its stored (server-computed) `total_price`. Returns the Stripe
redirect URL.

### `GET /orders/:id?email=...`
Customer order lookup — requires the order ID and matching email as a
lightweight guard since there's no auth. Returns status and item summary.

### `POST /uploads`
Multipart form with one file field named `image`. Every upload goes
through the backend, whichever storage driver is active, so it can be
checked and cleaned up:

- **Type:** JPEG, PNG or WebP, detected by decoding the file contents. The
  file name and Content-Type are ignored. HEIC gets a specific "export as
  JPEG" message.
- **Size:** at most `UPLOAD_MAX_MB` (default 25).
- **Resolution:** the long edge (after rotation) must be at least
  `UPLOAD_MIN_LONG_EDGE_PX` (default 2000).
- **Rotation:** the EXIF orientation is baked into the pixels, so sideways
  phone photos print upright. EXIF (including GPS) is stripped, and the
  colour profile is kept.
- **Name:** stored under a random key (`<uuid>.<ext>`).

Response (201):
```json
{ "data": { "imageKey": "3f2b…0b3c.jpg", "width": 3024, "height": 4032 }, "error": null }
```
Any failed check is a 400 `VALIDATION_ERROR` with a customer-readable
`message`.

### `GET /files/:key?exp=…&sig=…`
An expiring download link for an uploaded image (HMAC-SHA256 over
`key.exp` with `FILE_LINK_SECRET`). The links come from the fulfillment
email and the admin endpoints; nothing public hands them out. With
`STORAGE_DRIVER=disk` it streams the file as an attachment. With `s3` it
302-redirects to a 5-minute S3 presigned URL (S3's own links can't last
30 days). A bad key, a bad signature or an expired link all return a plain
404.

Individual links can't be revoked. Rotating `FILE_LINK_SECRET` invalidates
every outstanding link.

## Webhook

### `POST /webhooks/stripe`
Raw body, verified via Stripe signature header. Handles
`checkout.session.completed` → marks the order `paid`, records the
`payment`, triggers the SES fulfillment + customer confirmation emails.
This is the only path allowed to mark an order paid.

## Admin endpoints

There's one operator and one shared secret. There are no accounts for
either admins or customers.

- **Header only:** every `/admin/*` request needs `X-Admin-Token` equal to
  `ADMIN_TOKEN`, otherwise 401 `UNAUTHORIZED`. A token sent in the query
  string (`?token=`, `?admin_token=`, `?adminToken=`) is rejected with 400,
  so it never ends up in URLs, logs or browser history.
- **Strength:** in production the server refuses to start unless
  `ADMIN_TOKEN` (and `FILE_LINK_SECRET`) is set, isn't the dev default, and
  is at least 32 characters. Generate one with `openssl rand -base64 48`.
- **Comparison:** both sides are SHA-256 hashed, then compared with
  `crypto.timingSafeEqual`, so neither timing nor length leaks.
- **Rate limit:** 10 failed attempts per 15 minutes per client IP. After
  that every admin request from that IP, even one with the right token,
  gets 429 `RATE_LIMITED` with `Retry-After` (seconds) until the window
  ends. Failures are logged with the IP, never the submitted value. The
  counters are in memory, so a restart clears them.
- **HTTPS:** with `NODE_ENV=production`, plain-HTTP admin requests get 403
  `FORBIDDEN`. TLS is terminated by Caddy, and the app trusts its
  `X-Forwarded-Proto`/`X-Forwarded-For` according to `TRUST_PROXY`.
- **Operator name:** `X-Admin-Name` (optional, max 80 characters, default
  `admin`) is recorded on status changes. It's self-declared, since one
  shared secret can't prove who someone is. The IP and user agent are
  recorded alongside it.

`frontend/admin.html` asks for the name and token once per browser tab
and keeps them in `sessionStorage`, which is cleared when the tab closes.

### `GET /admin/orders`
Lists orders, filterable by `status`, for the manual fulfillment workflow.

### `GET /admin/orders/:id`
The full order (same shape as the customer lookup). Each item also has
`downloadUrl` and `downloadExpiresAt`, a freshly signed link valid for
`DOWNLOAD_LINK_TTL_DAYS` (default 30). Also includes `statusEvents`, the
order's status history, oldest first:
`[{ "fromStatus", "toStatus", "changedBy", "ip", "userAgent", "createdAt" }]`.

### `POST /admin/orders/:id/download-links`
Issues new links for every item in the order:
`[{ "itemId": "…", "url": "…", "expiresAt": "…" }]`. This backs the
"Generate fresh links" button for when the supplier's emailed link has
expired.

### `PATCH /admin/orders/:id/status`
Updates an order's status (`in_production`, `shipped`, `delivered`,
`cancelled`). Triggers a customer email on `shipped`. Setting the status
the order already has is a 400, which also stops a duplicate "shipped"
email. Every change writes an `order_status_events` row (`X-Admin-Name`,
IP, user agent) in the same transaction, plus a console line:
`[admin] <name>@<ip> changed order <id> <from> → <to>`. The Stripe
webhook's `pending_payment → paid` is recorded too, as `stripe-webhook`.
