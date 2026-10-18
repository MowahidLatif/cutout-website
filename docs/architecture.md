# Architecture & Engineering Spec — v1

## 1. Goal

Let a customer land on the site, understand the pitch ("cheapest, highest
quality life-size cutouts"), configure and pay for an order in a few
minutes, and have that order reliably routed to fulfillment — without
building any supplier-facing automation before a supplier relationship is
locked in, and without any frontend tooling heavier than plain HTML/CSS/JS.

## 2. User flow (v1)

1. Customer lands on `index.html`, a one-page storefront (hero → studio →
   how it works → gallery). The prices on `pricing.html` come live from
   `GET /api/pricing-config`.
2. In the **studio** (`index.html#studio`):
   - uploads a photo (validated and auto-rotated by the backend right away)
   - sets the real-world height (1–8 ft, manual, not AI-detected); the
     size tier and price follow from the height, and the width follows
     from the photo's proportions unless unlocked
   - optionally adds up to 3 text elements (speech bubble / placard / caption)
   - picks the material (Premium Corrugated = `coroplast`; others "coming soon")
     and the quantity
   - sees it **to scale** against a 9 ft wall, with a **live price**
     (vanilla JS, same formula as the backend)
   - adds it to the **cart** (kept in the browser), and can design more
3. At `checkout.html` the customer enters email, phone and shipping
   address, sees the full summary, and clicks "Pay with Stripe". Then
   The customer must tick the final-sale box (custom-made, so no returns;
   free reprint if damaged). Then `POST /api/orders` creates one order
   (in CAD) with all the cart items, and
   `POST /api/orders/:id/checkout-session` returns the Stripe redirect URL.
4. Stripe redirects back to `order-status.html?order=<id>`, which clears
   the cart. A webhook (`POST /api/webhooks/stripe`)
   confirms payment server-side — never trust the redirect alone — and
   flips the order to `paid`
5. Backend sends a fulfillment email (SES) to an internal address with full
   order details and an expiring (default 30-day) image download link
6. A human forwards that to the supplier contact, and later updates the
   order's status (`in_production` → `shipped` → `delivered`) through a
   small admin endpoint. `admin.html` can issue a fresh image link if the
   supplier's has expired
7. Customer can check order status via `order-status.html` (order ID + email)

## 3. High-level components

```
┌──────────────────┐      ┌──────────────┐      ┌─────────────┐
│  Static HTML/CSS/ │─────▶│   Express    │─────▶│  PostgreSQL │
│   vanilla JS      │◀─────│   Backend    │◀─────│    (RDS)    │
└──────────────────┘      └──────┬───────┘      └─────────────┘
                                  │
                      ┌───────────┼───────────┐
                      ▼           ▼           ▼
                   AWS S3      Stripe       AWS SES
                  (images)    (payment)   (fulfillment +
                                          customer emails)
```

Images always pass through the backend (`POST /api/uploads`) so they
can be validated and auto-rotated. They're stored on S3 in production or
on local disk in dev (`STORAGE_DRIVER`), so the whole flow runs without
AWS.

The frontend can be hosted as plain static files (S3 + CloudFront, or
anywhere that serves static HTML) — there's no build step and nothing to
compile.

## 4. Key architectural decisions

- **Plain HTML/CSS/vanilla JS frontend, not React.** No component framework,
  no bundler, no build step. Each page is a standalone `.html` file. This
  keeps the frontend trivially easy to host, debug, and hand off.
- **Flat Express backend, not a layered architecture.** Routes call
  services, services talk to the database. No DTO/validator/repository
  ceremony — the project is small enough that this would be overhead, not
  structure.
- **Single database (Postgres), not Postgres + Mongo.** Every entity here
  is relational (orders, order items, payments, pricing config). `jsonb`
  columns cover anything semi-structured (shipping address, Stripe webhook
  payloads).
- **No `users` table in v1.** No auth, so customer identity is just the
  email/phone/shipping address captured on the `orders` row itself.
- **Stripe Checkout (hosted), not Stripe Elements.** Fastest to ship, PCI
  compliance handled by Stripe.
- **Pricing config lives in the database**, not hardcoded, because supplier
  costs and margins aren't finalized and will change without a code deploy.
- **Price is computed twice, intentionally**: once in the browser (for
  instant feedback as the customer configures their order) and once
  server-side (authoritative, right before creating the Stripe session).
  The server-side value is what's ever charged.
- **Fulfillment is manual/email-based in v1.** No supplier API integration
  — it doesn't exist yet since the supplier relationship isn't finalized.

## 5. Explicit non-goals for v1

- User accounts / login
- AI-based height detection or background removal
- Automated supplier API/EDI integration
- Multi-supplier routing logic
- Refund/dispute automation (handle manually via Stripe dashboard for now)
- Any frontend build tooling (bundlers, JSX, CSS preprocessors)

## 6. Where to go next

- Frontend conventions and page breakdown: `frontend-guide.md`
- Backend route/service structure: `backend-guide.md`
- Table definitions: `database-schema.md`
- Endpoint contracts: `api-spec.md`
