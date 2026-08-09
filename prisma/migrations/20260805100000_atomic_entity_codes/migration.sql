-- Atomic, per-year sequence numbers for human-readable entity codes.
--
-- The previous implementation derived the next number from COUNT(*), which has
-- two defects: two concurrent registrations read the same count and generate the
-- same code (a unique-constraint 500 for whichever loses), and any deletion makes
-- the counter go backwards and collide with an existing code.
--
-- `next_entity_code` increments a per-scope counter atomically: the
-- ON CONFLICT DO UPDATE takes a row lock, so concurrent callers serialize and
-- each receives a distinct value. Scope is "<entity>:<year>", so numbering still
-- restarts each year, and the counter never decreases when rows are deleted.

CREATE TABLE IF NOT EXISTS "code_counters" (
  "scope" TEXT PRIMARY KEY,
  "value" BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION "next_entity_code"(p_scope TEXT)
RETURNS BIGINT AS $$
DECLARE
  next_value BIGINT;
BEGIN
  INSERT INTO "code_counters" ("scope", "value")
    VALUES (p_scope, 1)
  ON CONFLICT ("scope")
    DO UPDATE SET "value" = "code_counters"."value" + 1
  RETURNING "value" INTO next_value;

  RETURN next_value;
END;
$$ LANGUAGE plpgsql;

-- Seed the counters from existing data so codes continue from the current high
-- water mark instead of restarting at 1 and colliding with historical rows.
DO $$
DECLARE
  y TEXT;
  max_batch BIGINT;
  max_delivery BIGINT;
BEGIN
  FOR y IN SELECT DISTINCT substring("batch_code" FROM 7 FOR 4) FROM "coffee_batches"
  LOOP
    SELECT COALESCE(MAX(CAST(substring("batch_code" FROM 12) AS BIGINT)), 0)
      INTO max_batch
      FROM "coffee_batches"
      WHERE "batch_code" LIKE 'BATCH-' || y || '-%';

    INSERT INTO "code_counters" ("scope", "value")
      VALUES ('batch:' || y, max_batch)
    ON CONFLICT ("scope") DO UPDATE SET "value" = GREATEST("code_counters"."value", max_batch);
  END LOOP;

  FOR y IN SELECT DISTINCT substring("delivery_code" FROM 5 FOR 4) FROM "deliveries"
  LOOP
    SELECT COALESCE(MAX(CAST(substring("delivery_code" FROM 10) AS BIGINT)), 0)
      INTO max_delivery
      FROM "deliveries"
      WHERE "delivery_code" LIKE 'DEL-' || y || '-%';

    INSERT INTO "code_counters" ("scope", "value")
      VALUES ('delivery:' || y, max_delivery)
    ON CONFLICT ("scope") DO UPDATE SET "value" = GREATEST("code_counters"."value", max_delivery);
  END LOOP;
END $$;
