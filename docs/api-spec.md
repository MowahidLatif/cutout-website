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
      "imageUrl": "https://s3.../abc.jpg",
      "sizeTier": "life_size",
      "material": "coroplast",
      "heightIn": 68,
      "quantity": 3
    }
  ]
}
```

`shippingAddress.country` must be `CA` or `US`. Anything else is a
`VALIDATION_ERROR`.

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

### `POST /uploads/presigned-url`
Returns a presigned S3 URL so the browser can upload the image directly to
S3 without routing the binary through the backend.

## Webhook

### `POST /webhooks/stripe`
Raw body, verified via Stripe signature header. Handles
`checkout.session.completed` → marks the order `paid`, records the
`payment`, triggers the SES fulfillment + customer confirmation emails.
This is the only path allowed to mark an order paid.

## Admin endpoints (v1: not yet auth-protected — flag before public deploy)

### `GET /admin/orders`
Lists orders, filterable by `status`, for the manual fulfillment workflow.

### `PATCH /admin/orders/:id/status`
Updates an order's status (`in_production`, `shipped`, `delivered`,
`cancelled`). Triggers a customer email on `shipped`.

> Before this is reachable beyond the project owner's own use, it needs at
> least a shared-secret or basic-auth gate — v1 assumes only the owner
> hits it directly.
