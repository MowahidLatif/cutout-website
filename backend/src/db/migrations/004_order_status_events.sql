-- Audit trail of every order status change: who (self-declared admin name,
-- or 'stripe-webhook'), from which IP/browser, and when. migrate.js re-runs
-- every file, so keep this idempotent.

CREATE TABLE IF NOT EXISTS order_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  changed_by   text NOT NULL,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_events_order_id_created_at
  ON order_status_events (order_id, created_at);
