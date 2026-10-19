-- Whether each item's print file has a transparent background (the customer
-- used background removal). Measured by the server from the stored file, so
-- the supplier knows to cut along the outline. Idempotent like 001–008.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS has_transparency boolean NOT NULL DEFAULT false;
