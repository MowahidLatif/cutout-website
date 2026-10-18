# API Spec (v1)

Base path: `/api`. JSON responses use the `{ data, error }` envelope
described in `backend-guide.md`. Exceptions are noted per endpoint.

## Errors

Every failure has the shape
`{ "data": null, "error": { "message": "...", "code": "..." } }`. The
`message` is safe to show to the user.

| `code` | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad input, a failed upload check, an invalid status change, paying an already-paid order |
| `UNAUTHORIZED` | 401 | admin token missing or wrong |
| `FORBIDDEN` | 403 | admin request over plain HTTP in production |
| `NOT_FOUND` | 404 | unknown or malformed order ID, or an email that doesn't match |
| `RATE_LIMITED` | 429 | too many failed admin attempts (`Retry-After` header, in seconds) |
| `INTERNAL_ERROR` | 500 | anything unexpected (logged server-side) |

`GET /files/:key` and `POST /webhooks/stripe` don't use the envelope (see
below). `GET /health` (outside `/api`) returns `{ "status": "ok" }`.

## Public endpoints

### `GET /pricing-config`
Returns the current `pricing_config` rows, `quantity_discount_tiers` and
`shipping_rates`, so the storefront can show prices without hardcoding
rates. All amounts are in `currency` (`CAD`).

```json
{
  "data": {
    "currency": "CAD",
    "rates": [
      { "sizeTier": "life_size", "material": "coroplast", "baseRate": 80.00 }
    ],
    "discountTiers": [
      { "minQty": 2, "maxQty": 4, "discountPct": 5 }
    ],
    "shippingRates": [
      { "country": "CA", "sizeTier": "life_size", "firstUnitRate": 168.00, "additionalUnitRate": 83.00 }
    ]
  },
  "error": null
}
```

### `POST /uploads`
A multipart form with one file field named `image`. Every upload goes
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

Any failed check, a missing file, or a field not named `image` is a 400
`VALIDATION_ERROR`. This endpoint is public and not rate-limited yet (a
known gap).

### `POST /orders`
Creates an order in `pending_payment` status. The server computes every
price from its own config (`backend-guide.md`, "Pricing service"); any
price fields the client sends are ignored.

Request:
```json
{
  "customerEmail": "jane@example.com",
  "customerPhone": "+1-204-555-0100",
  "shippingAddress": { "line1": "...", "line2": "", "city": "...", "region": "...", "postalCode": "...", "country": "CA" },
  "acceptedFinalSale": true,
  "items": [
    {
      "imageKey": "3f2b7c1e-8d4a-4f6b-9c2e-1a5d7e9f0b3c.jpg",
      "material": "coroplast",
      "heightIn": 68,
      "widthIn": 51,
      "quantity": 3,
      "textElements": [{ "style": "bubble", "text": "Happy 40th, Dave!" }],
      "notes": "optional"
    }
  ]
}
```

**The size tier isn't sent; it's derived from `heightIn`**:
≤ 36" small, ≤ 60" medium, ≤ 78" life-size, otherwise XL. Any `sizeTier`
in the request is ignored, so a 7 ft standee can't be priced as "small".

Validation (each rule is a 400 `VALIDATION_ERROR` with a specific message):
- `acceptedFinalSale` must be exactly `true`: the customer ticked "I understand each standee is
  custom-made and final sale" at checkout. The server stores `finalSaleAcceptedAt` (now) and
  `finalSalePolicyVersion`, which is evidence if a payment is later disputed.
- `customerEmail` looks like an email, and `customerPhone` is present.
- `shippingAddress` has at least `line1` and `city`, and `country` is
  `CA` or `US`.
- At least one item. Each item needs:
  - `material`: one of `cardboard`, `coroplast`, `foam_board`, `acrylic`.
    The storefront only offers `coroplast` ("Premium Corrugated") for now,
    but the API accepts any configured material.
  - `quantity`: a whole number ≥ 1.
  - `heightIn`: 12–96 (1–8 ft).
  - `widthIn` (optional): 6–96. The studio sends the printed width, either
    auto-calculated from the photo's proportions or set by hand.
  - `textElements` (optional): up to 3 items of
    `{ style: "bubble" | "placard" | "caption", text: 1–80 characters }`.
    Text is trimmed.
  - an `imageKey` that is well-formed **and** exists in storage (i.e. it
    came from `POST /uploads`)

Response (201): the full order, in the same shape as `GET /orders/:id`.
For 3 × life-size coroplast to CA with the seed config (CAD), that's
`subtotal 240.00`, `discountAmount 12.00`, `shippingAmount 334.00`, and
`totalPrice 562.00`, with `currency: "CAD"`.

### `POST /orders/:id/checkout-session`
Creates a Stripe Checkout Session for an order that's still
`pending_payment`. It charges the order's **stored** `totalPrice`, the
amount computed when the order was created, in **CAD**, as a single line
item; nothing is recalculated here. Stripe's payment page also shows the
final-sale notice next to the pay button (`custom_text.submit`). If
Adaptive Pricing is on in the Stripe Dashboard, customers outside Canada
see their local currency, but the charge still settles in CAD. Response: `{ "url": "<Stripe checkout URL>" }`.

A `paid`/later or `cancelled` order gets 400 `VALIDATION_ERROR`, so a
paid order can never be charged twice. An unknown ID gets 404.

### `GET /orders/:id?email=...`
Customer order lookup. There are no accounts, so the order ID plus the
**required** matching email (case-insensitive) is the only guard. A
missing, blank or wrong email, or an unknown or malformed ID, all give the
same 404, so none of them reveals whether the order exists.

Response: the full order.
```json
{
  "id": "…", "status": "paid",
  "customerEmail": "…", "customerPhone": "…",
  "shippingAddress": { "line1": "…", "city": "…", "region": "…", "postalCode": "…", "country": "CA" },
  "subtotal": 240, "discountAmount": 12, "shippingAmount": 334, "totalPrice": 562, "currency": "CAD",
  "finalSaleAcceptedAt": "…", "finalSalePolicyVersion": "2026-10-18",
  "stripeSessionId": "…", "createdAt": "…", "updatedAt": "…",
  "items": [
    { "id": "…", "imageKey": "….jpg", "sizeTier": "life_size", "material": "coroplast",
      "heightIn": 68, "widthIn": 51, "textElements": [{ "style": "bubble", "text": "Happy 40th, Dave!" }],
      "quantity": 3, "unitPrice": 76, "lineTotal": 228 }
  ]
}
```

### `GET /files/:key?exp=…&sig=…`
An expiring download link for an uploaded image (HMAC-SHA256 over
`key.exp` with `FILE_LINK_SECRET`). Links are only issued by the
fulfillment email and the admin endpoints. With `STORAGE_DRIVER=disk`
it streams the file as an attachment. With `s3` it 302-redirects to a
5-minute S3 presigned URL, because S3's own links can't last 30 days.

A bad key, a bad signature or an expired link all return a plain-text
404, not the JSON envelope. Individual links can't be revoked; rotating
`FILE_LINK_SECRET` invalidates every outstanding link.

## Webhook

### `POST /webhooks/stripe`
Raw body, verified with the `Stripe-Signature` header and
`STRIPE_WEBHOOK_SECRET`. A bad signature gets 400 (plain text).

On `checkout.session.completed`, in one SQL statement, it:
- marks the order `paid` (only if it was `pending_payment`)
- writes an `order_status_events` row (`changed_by = stripe-webhook`)
- writes a `payments` row (the payment intent ID, the amount and currency
  Stripe actually charged, and the raw event)

It then sends the fulfillment email and the customer confirmation. If
Stripe's amount differs from the order total, it logs a warning. Retries
of the same event change nothing. This is the only path that can mark an
order paid.

It always responds `{ "received": true }` once the signature checks out,
even if processing failed (the failure is logged). A retry wouldn't fix a
bug on our side.

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

### `GET /admin/orders?status=...`
Lists orders, newest first, optionally filtered by `status`. Each item is
`{ "id", "customerEmail", "status", "totalPrice", "createdAt" }`.

### `GET /admin/orders/:id`
The full order (same shape as the customer lookup), plus:
- each item gets `downloadUrl` and `downloadExpiresAt`, a freshly signed
  link valid for `DOWNLOAD_LINK_TTL_DAYS` (default 30). Both are `null`
  for items from before `003_image_key.sql`.
- `statusEvents`: the status history, oldest first:
  `[{ "fromStatus", "toStatus", "changedBy", "ip", "userAgent", "createdAt" }]`.

### `POST /admin/orders/:id/download-links`
Issues new links for every item in the order:
`[{ "itemId": "…", "url": "…", "expiresAt": "…" }]`. This backs the
"Generate fresh links" button for when the supplier's emailed link has
expired.

### `PATCH /admin/orders/:id/status`
Body: `{ "status": "in_production" | "shipped" | "delivered" | "cancelled" }`.
`paid` can't be set here; only the webhook does that. Returns the
updated order.

- Setting the status the order already has is a 400. That also stops a
  duplicate "shipped" email.
- `shipped` emails the customer.
- Each change writes an `order_status_events` row (`X-Admin-Name`, IP,
  user agent) in the same transaction, and logs a console line:
  `[admin] <name>@<ip> changed order <id> <from> → <to>`.
