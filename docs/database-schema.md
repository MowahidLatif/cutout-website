# Database Schema (PostgreSQL)

No `users` table in v1 — there's no auth. Customer identity lives directly
on the `orders` row. See `backend/src/db/migrations/001_init.sql` for the
runnable version of this.

## `orders`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| customer_email | text | required |
| customer_phone | text | required |
| shipping_address | jsonb | `{ line1, line2, city, region, postal_code, country }` |
| status | text (enum) | `pending_payment`, `paid`, `in_production`, `shipped`, `delivered`, `cancelled` |
| subtotal | numeric(10,2) | pre-discount total across all items |
| discount_amount | numeric(10,2) | for audit/display |
| total_price | numeric(10,2) | what was actually charged |
| stripe_session_id | text | nullable until checkout session created |
| stripe_payment_intent_id | text | nullable until paid |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## `order_items`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | |
| image_url | text | S3 object URL |
| size_tier | text (enum) | `small`, `medium`, `life_size`, `xl` |
| material | text (enum) | `cardboard`, `coroplast`, `foam_board`, `acrylic` |
| height_in | numeric(6,2) | manually entered by customer |
| quantity | integer | |
| unit_price | numeric(10,2) | snapshot at time of order (config may change later) |
| line_total | numeric(10,2) | `unit_price * quantity` |
| notes | text | nullable, free-form |

## `pricing_config`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| size_tier | text | see above |
| material | text | see above |
| base_rate | numeric(10,2) | |
| updated_at | timestamptz | |

Unique on `(size_tier, material)`.

## `quantity_discount_tiers`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| min_qty | integer | inclusive |
| max_qty | integer, nullable | inclusive; `null` means "and above" |
| discount_pct | numeric(5,2) | e.g. `10.00` for 10% |

Starting v1 values (adjust once real costs/margins are known):

| min_qty | max_qty | discount_pct |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 4 | 5 |
| 5 | 9 | 10 |
| 10 | 24 | 15 |
| 25 | null | 20 |

## `payments`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | |
| provider | text | `stripe` |
| provider_txn_id | text | Stripe payment intent ID |
| amount | numeric(10,2) | |
| status | text (enum) | `pending`, `succeeded`, `failed`, `refunded` |
| raw_payload | jsonb | raw webhook payload, for debugging/audit |
| created_at | timestamptz | |

## Notes

- Status/tier/material columns use `text` with a `CHECK` constraint rather
  than a Postgres `enum` type, to keep the migration file simple (no
  `ALTER TYPE` ceremony later if a value needs adding).
- `pricing_config` and `quantity_discount_tiers` are seeded with
  placeholder rates in the migration — edit them directly once real
  supplier costs are known.
