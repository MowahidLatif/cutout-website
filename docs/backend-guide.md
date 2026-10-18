# Backend Guide

Read `architecture.md` first. This doc governs everything under `backend/`.

## Philosophy

Flat and boring on purpose: **routes → services → db**. No DTOs, no
validator classes, no repository layer, no domain models. A route handler
is allowed to do light inline validation (check required fields, valid
enum values) — it doesn't need its own file for that at this size.

## Folder structure

```
backend/
├── package.json
├── .env.example
└── src/
    ├── server.js              — Express app setup, mounts routes, starts
    │                             the server
    ├── routes/
    │   ├── pricing.js          — GET /api/pricing-config
    │   ├── orders.js           — POST /orders, POST /orders/:id/checkout-session,
    │   │                         GET /orders/:id
    │   ├── webhooks.js         — POST /webhooks/stripe
    │   └── admin.js            — GET /admin/orders, PATCH /admin/orders/:id/status
    ├── services/
    │   ├── pricing.js          — calculatePrice(...) — the authoritative
    │   │                         version of the formula in frontend/js/pricing.js
    │   ├── orders.js           — createOrder, getOrderById, markOrderPaid,
    │   │                         updateOrderStatus — talks to the db pool
    │   │                         directly (no separate repository layer)
    │   ├── stripe.js           — createCheckoutSession, verifyWebhookSignature
    │   └── email.js            — sendFulfillmentEmail, sendCustomerConfirmation,
    │                             sendShippedNotification (SES in production;
    │                             logs to console in dev if SES isn't configured)
    └── db/
        ├── pool.js             — pg Pool, reads connection info from env
        └── migrations/
            ├── 001_init.sql    — creates all tables + seeds starter
            │                     pricing_config / quantity_discount_tiers rows
            └── 002_shipping.sql — shipping_rates table + orders.shipping_amount
                                  (migrate.js re-runs every file, so keep
                                  migrations idempotent)
```

## Request lifecycle (example: placing an order)

```
POST /api/orders
  → routes/orders.js
      reads req.body, does light validation (required fields present,
      size/material are valid enum values, quantity > 0)
      → services/pricing.js: calculatePrice(...) using current db rates
      → services/orders.js: createOrder(...) inserts the order + items
      → responds with the created order (incl. server-computed totals)
```

No class hierarchies, no dependency injection — a service file is just a
module exporting a few `async function`s that take plain arguments and
return plain objects.

## Response shape

Keep it simple and consistent:

```json
{ "data": { ... }, "error": null }
```

or on failure:

```json
{ "data": null, "error": { "message": "...", "code": "VALIDATION_ERROR" } }
```

## Pricing service (critical — must match the frontend's copy)

`services/pricing.js` owns `calculatePrice(...)`. This is the
**authoritative** version — `frontend/js/pricing.js` exists only for live
UI feedback. If the formula changes, update both, and keep them deriving
from the same shape of config data (`pricing_config` rows +
`quantity_discount_tiers` rows) rather than diverging.

Order of operations:

1. Look up `base_rate` for `(size_tier, material)` from `pricing_config`
2. Look up `discount_pct` for the quantity from `quantity_discount_tiers`
   (match into the `[min_qty, max_qty]` range)
3. `unit_price = base_rate * (1 - discount_pct / 100)`
4. `line_total = unit_price * quantity`
5. `calculateShipping(...)`: look up `(country, size_tier)` in
   `shipping_rates`; `shipping = first_unit_rate + additional_unit_rate * (quantity - 1)`.
   The quantity discount never applies to shipping.
6. `total_price = sum(line_total) + sum(shipping)`
7. Round to 2 decimals; store subtotal/discount/shipping/total separately
   on the order for auditability

This function is called again server-side — recomputed from the submitted
order, never trusted from the client — immediately before creating the
Stripe Checkout session.

## Stripe integration

- `services/stripe.js` creates the Checkout Session using the
  server-recomputed total, not whatever price the client sent
- `POST /api/webhooks/stripe` (raw body, signature-verified) is the only
  route allowed to mark an order `paid` — never trust the client redirect
- On `checkout.session.completed`, call `ordersService.markOrderPaid(id)`,
  which also triggers the SES fulfillment + customer confirmation emails

## Email (SES)

`services/email.js` wraps SES. In local dev, if AWS credentials/SES aren't
configured, these functions should just `console.log` what would have been
sent rather than throwing — keeps local development simple.
