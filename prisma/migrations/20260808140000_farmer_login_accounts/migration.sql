-- Farmer login accounts.
--
-- Cooperative staff register farmers on a form that never asks for an email
-- address, because farmers here generally do not have one. Until now `users.email`
-- was NOT NULL, so a farmer could not be given an account at all without
-- inventing a placeholder address — data that looks real, pollutes every list
-- that shows an email, and would silently break any future reset-by-email.
--
-- Dropping the NOT NULL is the honest representation: a farmer has no email, and
-- signs in with their phone number or their printed farmer code instead. The
-- UNIQUE index survives, because Postgres treats NULLs as distinct.

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Credential lifecycle for an account provisioned on someone else's behalf. The
-- temporary password travels on paper, so it is treated as a one-time handover:
-- `must_change_password` blocks every route until it is replaced, and the expiry
-- stops an unclaimed slip from staying valid indefinitely.
ALTER TABLE "users"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "password_changed_at" TIMESTAMP(3),
  ADD COLUMN "temporary_password_expires_at" TIMESTAMP(3);

-- Farmer codes become login identifiers, so a duplicate is no longer merely a
-- 500 on registration — it would be two people sharing one credential. Move
-- farmer numbering onto the same atomic counter batches and deliveries already
-- use (`next_entity_code`, added in 20260805100000_atomic_entity_codes) and seed
-- it from the current high-water mark so codes continue rather than restart.
DO $$
DECLARE
  y TEXT;
  max_farmer BIGINT;
BEGIN
  FOR y IN SELECT DISTINCT substring("farmer_code" FROM 6 FOR 4)
             FROM "farmers"
            WHERE "farmer_code" ~ '^FARM-[0-9]{4}-[0-9]+$'
  LOOP
    SELECT COALESCE(MAX(CAST(substring("farmer_code" FROM 11) AS BIGINT)), 0)
      INTO max_farmer
      FROM "farmers"
     WHERE "farmer_code" LIKE 'FARM-' || y || '-%'
       AND "farmer_code" ~ '^FARM-[0-9]{4}-[0-9]+$';

    INSERT INTO "code_counters" ("scope", "value")
      VALUES ('farmer:' || y, max_farmer)
    ON CONFLICT ("scope") DO UPDATE
      SET "value" = GREATEST("code_counters"."value", max_farmer);
  END LOOP;
END $$;
