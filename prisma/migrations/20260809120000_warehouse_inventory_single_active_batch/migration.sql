-- At most one open inventory row per batch.
--
-- The application already checks for an existing active row inside the store
-- transaction, and that check is what produces the friendly error. This index is
-- the second line: two concurrent store requests can both pass their check
-- before either writes, and only a constraint can settle which one wins. A
-- partial index (rather than a plain unique on batch_id) is what keeps the
-- history intact — a batch may be stored, checked out, and stored again, so only
-- the rows with `removed_at IS NULL` are constrained.
--
-- Prisma cannot express partial indexes in schema.prisma, so this one is
-- hand-written. `prisma migrate dev` will not know about it; keep this
-- migration file as its definition.

-- Fail loudly rather than silently dropping rows if a database already carries
-- duplicates: the operator needs to decide which open row is the real one.
DO $$
DECLARE
  duplicates INT;
BEGIN
  SELECT COUNT(*) INTO duplicates
  FROM (
    SELECT "batch_id"
    FROM "warehouse_inventory"
    WHERE "removed_at" IS NULL
    GROUP BY "batch_id"
    HAVING COUNT(*) > 1
  ) d;

  IF duplicates > 0 THEN
    RAISE EXCEPTION
      'Cannot create warehouse_inventory_active_batch_key: % batch(es) have more than one open inventory row. Close the duplicates first.',
      duplicates;
  END IF;
END $$;

CREATE UNIQUE INDEX "warehouse_inventory_active_batch_key"
  ON "warehouse_inventory" ("batch_id")
  WHERE "removed_at" IS NULL;
