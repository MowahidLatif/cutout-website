-- Uploaded images are now referenced by an opaque storage key
-- ("<uuid>.jpg") instead of a public URL, so the same order rows work with
-- either storage driver (disk or s3). migrate.js re-runs every file, so
-- only rename while the old column still exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_items' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE order_items RENAME COLUMN image_url TO image_key;
  END IF;
END $$;
