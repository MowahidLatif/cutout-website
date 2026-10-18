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

Every `/admin/*` request needs an `X-Admin-Token` header equal to the
`ADMIN_TOKEN` env var, otherwise 401 `UNAUTHORIZED`. `frontend/admin.html`
asks for the token once and keeps it in `sessionStorage`. The server
refuses to start with `NODE_ENV=production` while `ADMIN_TOKEN` or
`FILE_LINK_SECRET` is unset or still the dev default.

### `GET /admin/orders`
Lists orders, filterable by `status`, for the manual fulfillment workflow.

### `GET /admin/orders/:id`
The full order (same shape as the customer lookup). Each item also has
`downloadUrl` and `downloadExpiresAt`, a freshly signed link valid for
`DOWNLOAD_LINK_TTL_DAYS` (default 30).

### `POST /admin/orders/:id/download-links`
Issues new links for every item in the order:
`[{ "itemId": "…", "url": "…", "expiresAt": "…" }]`. This backs the
"Generate fresh links" button for when the supplier's emailed link has
expired.

### `PATCH /admin/orders/:id/status`
Updates an order's status (`in_production`, `shipped`, `delivered`,
`cancelled`). Triggers a customer email on `shipped`.
