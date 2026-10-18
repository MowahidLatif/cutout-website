-- Initial schema for the cutout ordering site.
-- No `users` table in v1 — there's no auth; customer identity lives
-- directly on the `orders` row. See docs/database-schema.md.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS orders (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_email            text NOT NULL,
  customer_phone            text NOT NULL,
  shipping_address          jsonb NOT NULL,
  status                    text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'in_production', 'shipped', 'delivered', 'cancelled')),
  subtotal                  numeric(10,2) NOT NULL DEFAULT 0,
  discount_amount           numeric(10,2) NOT NULL DEFAULT 0,
  total_price                numeric(10,2) NOT NULL DEFAULT 0,
  stripe_session_id          text,
  stripe_payment_intent_id   text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  image_url      text NOT NULL,
  size_tier      text NOT NULL CHECK (size_tier IN ('small', 'medium', 'life_size', 'xl')),
  material       text NOT NULL CHECK (material IN ('cardboard', 'coroplast', 'foam_board', 'acrylic')),
  height_in      numeric(6,2) NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  unit_price     numeric(10,2) NOT NULL,
  line_total     numeric(10,2) NOT NULL,
  notes          text
);

CREATE TABLE IF NOT EXISTS pricing_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  size_tier   text NOT NULL CHECK (size_tier IN ('small', 'medium', 'life_size', 'xl')),
  material    text NOT NULL CHECK (material IN ('cardboard', 'coroplast', 'foam_board', 'acrylic')),
  base_rate   numeric(10,2) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (size_tier, material)
);

CREATE TABLE IF NOT EXISTS quantity_discount_tiers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min_qty        integer NOT NULL UNIQUE,
  max_qty        integer, -- NULL means "and above"
  discount_pct   numeric(5,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'stripe',
  provider_txn_id   text,
  amount            numeric(10,2) NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  raw_payload       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- Seed starter pricing (placeholder values — adjust once real
-- supplier costs/margins are known) ----------

INSERT INTO pricing_config (size_tier, material, base_rate) VALUES
  ('small',     'cardboard',  25.00),
  ('small',     'coroplast',  32.00),
  ('small',     'foam_board', 38.00),
  ('small',     'acrylic',    60.00),
  ('medium',    'cardboard',  35.00),
  ('medium',    'coroplast',  45.00),
  ('medium',    'foam_board', 53.00),
  ('medium',    'acrylic',    85.00),
  ('life_size', 'cardboard',  45.00),
  ('life_size', 'coroplast',  58.00),
  ('life_size', 'foam_board', 68.00),
  ('life_size', 'acrylic',    110.00),
  ('xl',        'cardboard',  60.00),
  ('xl',        'coroplast',  78.00),
  ('xl',        'foam_board', 92.00),
  ('xl',        'acrylic',    150.00)
ON CONFLICT (size_tier, material) DO NOTHING;

INSERT INTO quantity_discount_tiers (min_qty, max_qty, discount_pct) VALUES
  (1,  1,    0.00),
  (2,  4,    5.00),
  (5,  9,    10.00),
  (10, 24,   15.00),
  (25, NULL, 20.00)
ON CONFLICT (min_qty) DO NOTHING;
