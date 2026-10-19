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
| `CONFLICT` | 409 | a status change that isn't allowed (admin) |
| `PAYLOAD_TOO_LARGE` | 413 | a JSON body over 100 kB, or an upload over `UPLOAD_MAX_MB` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | an upload that isn't JPEG, PNG, WebP, HEIC or PDF |
| `RATE_LIMITED` | 429 | too many requests (`Retry-After` header, in seconds); see "Rate limits" |
| `INTERNAL_ERROR` | 500 | anything unexpected. Logged server-side; in production the message is generic (no stack traces or SQL errors) |

## Rate limits

Per client IP, in 15-minute windows, kept in memory (fine for one server; a
restart resets them):

| Endpoint | Limit |
|---|---|
| `POST /orders` | 10 |
| `POST /orders/:id/checkout-session` | 10 |
| `POST /uploads` | 20 |
| `GET /orders/:id` (lookup) | 30 |
| `/admin/*` | 10 failed sign-ins; 300 in total |

`/webhooks/stripe` and `/health` are never limited. Over the limit you get
429 `RATE_LIMITED` with `Retry-After`. The client IP comes from
`TRUST_PROXY` / `CLIENT_IP_HEADER` (see `backend-guide.md`).

JSON bodies are capped at **100 kB** (413). The Stripe webhook's raw body
has its own parser.

`GET /files/:key` and `POST /webhooks/stripe` don't use the envelope (see
below). `GET /health` (outside `/api`) returns `{ "status": "ok" }`.

Any other `/api/*` path is a JSON 404 (`NOT_FOUND`). Everything outside
`/api` is the website itself: `frontend/` is served by the same app, with
clean URLs (`/pricing` → `pricing.html`). See `backend-guide.md`, "One port". The
browser calls the API on the same origin, so no CORS headers are sent unless
`FRONTEND_ORIGIN` is set.

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

- **Type** (detected from the file contents; the file name and Content-Type
  are ignored):
  - **JPEG, PNG, WebP:** kept as they are.
  - **HEIC** (iPhone): converted to JPEG.
  - **PDF:** page 1 rendered to a PNG about 6000 px on its long side. A
    multi-page PDF returns a `note`. A password-protected or broken PDF is
    a 400.
  - **Anything else** (GIF, TIFF, AVIF, SVG, non-images): **415**
    `UNSUPPORTED_MEDIA_TYPE`.
- **Size:** at most `UPLOAD_MAX_MB` (**default 18 MB**), otherwise 413. That's
  the most a file can be and still go by email: mailboxes cap a whole
  message at 20–25 MB, and attachments grow by about a third when encoded.
  The stored print file is kept under the same limit; if processing makes
  it bigger, it's re-encoded as JPEG and scaled down until it fits.
- **No minimum resolution.** The response includes the pixel size, and the
  studio shows a 0–100 print-quality score. Photos under 1000 px on their
  long side can't score above "fair". A **low** rating has to be confirmed
  per item when ordering (see `POST /orders`).
- **Rotation:** the EXIF orientation is baked into the pixels, so sideways
  phone photos print upright. EXIF (including GPS) is stripped, and the
  colour profile is kept.
- **Name:** stored under a random key (`<uuid>.<ext>`).

Response (201):
```json
{ "data": {
    "imageKey": "3f2b…0b3c.jpg", "width": 3024, "height": 4032,
    "previewUrl": "/api/files/3f2b…0b3c.jpg?exp=…&sig=…",
    "note": null
  }, "error": null }
```
`previewUrl` is a 24-hour signed link to the **processed** image (rotated,
converted from PDF/HEIC). The studio displays this, since browsers can't
show PDF or HEIC files as images. `note` is set for multi-page PDFs, e.g.
"Your PDF has 3 pages — we'll print page 1." 

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
  "customerName": "Jane Doe",
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
- `customerName` (**required**, up to 100 characters). Field limits:
  `customerEmail` 254, `customerPhone` 30, address lines, city and region
  200, `postalCode` 20, item `notes` 2000.
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
  - `quantity`: a whole number from 1 to 500.
  - `heightIn`: 12–96 (1–8 ft).
  - `widthIn` (optional): 6–96. The studio sends the printed width, either
    auto-calculated from the photo's proportions or set by hand.
  - `acceptedLowQuality` (optional, boolean): required (`true`) when the
    photo would print at **low** quality at this size. The server measures
    the stored image itself:
    - `ppi = min(pixelWidth / widthIn, pixelHeight / heightIn)`
    - `score = min(100, ppi × 2)`, capped at 59 when the long edge is under
      1000 px
    - great ≥ 90, good ≥ 60, fair ≥ 36, otherwise low

    It stores the pixel size, ppi, score and confirmation on the item.
  - `textElements` (optional): up to 3 items of
    `{ style: "bubble" | "placard" | "caption", text: 1–100 characters }`.
    Text is trimmed.
  - an `imageKey` that is well-formed **and** exists in storage (i.e. it
    came from `POST /uploads`)
- **Per-order limits:** at most **500 cutouts** in total (the sum of every
  item's `quantity`) and at most **10 different photos** (distinct
  `imageKey`s; the same photo used for two sizes counts once).
  Example: CEO × 5, mascot × 20, speaker × 2 = 27 cutouts, 3 photos.

Pricing: each item gets its own bulk discount from its own quantity.
Shipping is priced for the whole order, with one first-unit charge (see
`database-schema.md`, `shipping_rates`).

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
      "imageWidthPx": 3024, "imageHeightPx": 4032, "printPpi": 59, "lowQualityAccepted": false,
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

There's one operator (the owner) and one shared secret. There are no
accounts for either admins or customers.

- **Auth:** every `/admin/*` request needs `Authorization: Bearer <ADMIN_TOKEN>`,
  otherwise 401 `UNAUTHORIZED`. A token in the query string (`?token=`,
  `?admin_token=`, `?adminToken=`) is rejected with 400, so it never ends up
  in URLs, logs or browser history.
- **Comparison:** both sides are SHA-256 hashed, then compared with
  `crypto.timingSafeEqual`, so neither timing nor length leaks.
- **Strength:** in production the server refuses to start unless
  `ADMIN_TOKEN` is set, isn't the dev default, and is at least 32 characters.
  Generate one with `openssl rand -base64 48`.
- **Rate limits:** 10 **failed** sign-ins per 15 minutes per client IP. After
  that, every admin request from that IP (even with the right token) gets 429
  until the window ends. Successful requests don't count toward the 10, but
  all admin requests together are capped at 300 per 15 minutes.
- **HTTPS:** with `NODE_ENV=production`, plain-HTTP admin requests get 403.
- **Operator name:** `X-Admin-Name` (optional, max 80 characters, default
  `admin`) is recorded on status changes and notes. It's self-declared,
  since one shared secret can't prove who someone is; the IP and user agent
  are recorded too.

`frontend/admin.html` asks for the name and token once per browser tab and
keeps them in `sessionStorage` (cleared when the tab closes), with a Log out
button. It's `noindex` and not linked from public pages.

### `GET /admin/orders`
Query: `status` (`needs_action` (the default: `paid` + `in_production`),
`all`, or one status), `q` (email or name substring, or an order-ID prefix),
`from` / `to` (`YYYY-MM-DD`, inclusive, on the created date), and `page`.
Newest first, **25 per page**.

```json
{ "orders": [{ "id": "…", "shortId": "c02a00ab", "customerName": "Acme Events", "customerEmail": "…",
    "status": "paid", "totalPrice": 860, "currency": "CAD", "itemCount": 1, "cutoutCount": 5,
    "country": "CA", "createdAt": "…" }],
  "page": 1, "pageSize": 25, "total": 1 }
```

### `GET /admin/orders/:id`
The full order (the customer-lookup shape plus `stripePaymentIntentId`,
`carrier`, `trackingNumber`, `trackingUrl`, `shippedAt`), and also:
- per item, `downloadUrl` and `downloadExpiresAt`: a freshly signed link,
  valid for `DOWNLOAD_LINK_TTL_DAYS` (default 30)
- `statusEvents`: the history, oldest first
  (`fromStatus`, `toStatus`, `changedBy`, `ip`, `userAgent`, `createdAt`)
- `notes`: internal notes (`id`, `body`, `author`, `createdAt`)
- `allowedNextStatuses`: what the status can change to from here

A malformed ID gets 400; an unknown one gets 404.

### `POST /admin/orders/:id/notes`
Body `{ "body": "…" }`, 1–2000 characters. Returns the notes list (201).
Notes are internal only: they never appear in customer responses or emails.

### `PATCH /admin/orders/:id/status`
Body: `{ "status", "carrier"?, "trackingNumber"?, "trackingUrl"? }`.

**Allowed transitions only**; anything else is a 409 `CONFLICT` that names
the allowed next statuses:

| From | To |
|---|---|
| `paid` | `in_production`, `cancelled` |
| `in_production` | `shipped`, `cancelled` |
| `shipped` | `delivered` |

`pending_payment → paid` is the Stripe webhook's job, never an admin's.

- **`shipped`** requires `carrier` and `trackingNumber` (each up to 100
  characters; otherwise 400). `trackingUrl` is optional, http(s), up to 500
  characters. They're stored on the order with `shipped_at`.
- Every change writes an `order_status_events` row in the same transaction.
- On `shipped`, the customer gets the shipped email with the carrier and
  tracking. **If that email fails, the status change still stands**: the
  failure is logged, and the response's `warning` says so (the admin page
  shows it). Otherwise `warning` is `null`.
- There's no refund action; refunds are done in the Stripe dashboard.

### `POST /admin/orders/:id/download-links`
Fresh 30-day image links for every item:
`[{ "itemId", "url", "expiresAt" }]`.

### `GET /admin/orders/:id/bundle`
The **supplier bundle**: a zip streamed straight from storage, through this
admin-authenticated endpoint. There's no public URL. It contains:
- `<orderId>-order-details.txt`: the order ID; per item the size,
  dimensions, material, quantity, text and print quality; the recipient's
  name, address, phone and email
- `<orderId>-item-<n>.<ext>`: each print file

The images are our processed print files (rotated; PDF page 1 / HEIC
converted). The original upload bytes aren't kept.
