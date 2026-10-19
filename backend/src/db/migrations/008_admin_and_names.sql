-- Admin workflow: the customer's name (asked at checkout), shipping/tracking
-- details captured when an order is marked shipped, the 0–100 print quality
-- score, and internal notes (never shown to customers).
-- migrate.js re-runs every file, so keep this idempotent.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS print_score integer;

CREATE TABLE IF NOT EXISTS order_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  author      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_notes_order_id_created_at ON order_notes (order_id, created_at);
CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status);
