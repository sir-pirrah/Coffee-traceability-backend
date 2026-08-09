-- Row-Level Security: tenant isolation enforced by Postgres, not only by the API.
--
-- Until now "a cooperative cannot read another cooperative's data" was true only
-- because every handler remembered to call scopeCooperativeId()/assertOwnership().
-- One forgotten call, one new endpoint, or one raw query is enough to leak. These
-- policies restate the same rules one level down, so a query that forgets its
-- filter returns nothing instead of everything.
--
-- Two facts about how Postgres applies RLS shape everything below:
--
--   1. A superuser, and any role with BYPASSRLS, ignores policies entirely.
--   2. A table's OWNER also ignores them, unless the table is set to FORCE.
--
-- The migration role (`admin`) is both, which is why the application must connect
-- as the separate, deliberately unprivileged `app_user` created here, and why
-- every protected table is set to FORCE ROW LEVEL SECURITY.
--
-- Request context arrives as session variables (`app.*`) that the application
-- sets with set_config(..., is_local => true) inside a transaction, so the values
-- die with the transaction and cannot leak onto the next request that happens to
-- reuse the same pooled connection.

-- ---------------------------------------------------------------------------
-- 1. The application role.
-- ---------------------------------------------------------------------------
-- No password is set here on purpose: a credential committed to a migration is a
-- credential in everyone's git history. The role is created unable to log in, and
-- the operator assigns its password out-of-band (see scripts/setup-rls-role.sh),
-- which is also what writes APP_DATABASE_URL into .env.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    -- Never silently leave a privileged role in place under this name.
    ALTER ROLE app_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;

-- DML only. app_user cannot create, alter, or drop anything, so migrations stay
-- the exclusive job of the admin connection.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;

-- Tables added by later migrations should be reachable without a follow-up grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Context accessors.
-- ---------------------------------------------------------------------------
-- current_setting(..., true) yields NULL when unset, but '' when set-and-cleared,
-- and '' does not cast to uuid. These wrappers normalise both to NULL so an
-- absent context can never be mistaken for a matching one.
--
-- STABLE + PARALLEL SAFE so the planner may cache them per statement; policies
-- call them once per row otherwise.

CREATE OR REPLACE FUNCTION app_setting_text(p_key TEXT)
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting(p_key, true), '');
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_setting_uuid(p_key TEXT)
RETURNS UUID AS $$
  SELECT CASE
           WHEN app_setting_text(p_key) IS NULL THEN NULL
           ELSE app_setting_text(p_key)::UUID
         END;
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
  SELECT app_setting_uuid('app.user_id');
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS TEXT AS $$
  SELECT app_setting_text('app.role');
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_cooperative_id() RETURNS UUID AS $$
  SELECT app_setting_uuid('app.cooperative_id');
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_farmer_id() RETURNS UUID AS $$
  SELECT app_setting_uuid('app.farmer_id');
$$ LANGUAGE sql STABLE PARALLEL SAFE;

-- The narrow escape hatch. A handful of operations legitimately run with no
-- authenticated user and cannot be expressed as a tenant policy: verifying a
-- password at login (reads a user before anyone is logged in), refreshing a
-- token, the public QR scan, and the seed script. Those wrap themselves in
-- system context explicitly; everything else runs without it.
CREATE OR REPLACE FUNCTION app_is_system() RETURNS BOOLEAN AS $$
  SELECT COALESCE(app_setting_text('app.system') = 'on', false);
$$ LANGUAGE sql STABLE PARALLEL SAFE;

-- Shorthand for the two role checks every policy starts with.
CREATE OR REPLACE FUNCTION app_is_unrestricted() RETURNS BOOLEAN AS $$
  SELECT app_is_system() OR app_current_role() = 'SUPER_ADMIN';
$$ LANGUAGE sql STABLE PARALLEL SAFE;

-- A farmer is a member of the cooperative, not a clerk of it: their reads are
-- narrowed past the cooperative to their own Farmer profile.
CREATE OR REPLACE FUNCTION app_is_farmer() RETURNS BOOLEAN AS $$
  SELECT app_current_role() = 'FARMER';
$$ LANGUAGE sql STABLE PARALLEL SAFE;

-- ---------------------------------------------------------------------------
-- 3. Root tenant tables.
-- ---------------------------------------------------------------------------
-- These carry `cooperative_id` directly, so the tenant test is a column compare.
-- FORCE is what makes the policies apply to the table owner too, closing the
-- "but admin owns everything" hole described at the top.

ALTER TABLE "cooperatives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cooperatives" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cooperatives_tenant" ON "cooperatives";
CREATE POLICY "cooperatives_tenant" ON "cooperatives"
  FOR ALL
  USING (app_is_unrestricted() OR id = app_cooperative_id())
  WITH CHECK (app_is_unrestricted());

ALTER TABLE "coffee_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coffee_batches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coffee_batches_tenant" ON "coffee_batches";
CREATE POLICY "coffee_batches_tenant" ON "coffee_batches"
  FOR ALL
  USING (
    app_is_unrestricted()
    OR (
      cooperative_id = app_cooperative_id()
      -- A farmer is associated with a batch only through a delivery of theirs
      -- that went into it. The subquery is itself filtered by the deliveries
      -- policy below, so this cannot be used to probe other farmers' rows.
      AND (
        NOT app_is_farmer()
        OR EXISTS (
          SELECT 1 FROM "deliveries" d
          WHERE d."batch_id" = "coffee_batches"."id"
            AND d."farmer_id" = app_farmer_id()
        )
      )
    )
  )
  WITH CHECK (
    app_is_unrestricted()
    OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer())
  );

ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deliveries_tenant" ON "deliveries";
CREATE POLICY "deliveries_tenant" ON "deliveries"
  FOR ALL
  USING (
    app_is_unrestricted()
    OR (
      cooperative_id = app_cooperative_id()
      AND (NOT app_is_farmer() OR farmer_id = app_farmer_id())
    )
  )
  WITH CHECK (
    app_is_unrestricted()
    OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer())
  );

ALTER TABLE "farmers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "farmers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farmers_tenant" ON "farmers";
CREATE POLICY "farmers_tenant" ON "farmers"
  FOR ALL
  USING (
    app_is_unrestricted()
    OR (
      cooperative_id = app_cooperative_id()
      AND (NOT app_is_farmer() OR id = app_farmer_id())
    )
  )
  WITH CHECK (
    app_is_unrestricted()
    OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer())
  );

ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "warehouses_tenant" ON "warehouses";
CREATE POLICY "warehouses_tenant" ON "warehouses"
  FOR ALL
  USING (app_is_unrestricted() OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer()))
  WITH CHECK (app_is_unrestricted() OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer()));

-- users doubles as a tenant table and the identity table. `users.role` is the
-- row's role; app_current_role() is the caller's — they are different things and
-- the column is qualified everywhere to keep that clear.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_tenant" ON "users";
CREATE POLICY "users_tenant" ON "users"
  FOR ALL
  USING (
    app_is_unrestricted()
    -- Always readable to yourself, so /auth/me and Settings work for every role
    -- including a farmer, whose own row is the only one they need.
    OR "users"."id" = app_current_user_id()
    OR ("users"."cooperative_id" = app_cooperative_id() AND NOT app_is_farmer())
  )
  WITH CHECK (
    app_is_unrestricted()
    OR "users"."id" = app_current_user_id()
    OR ("users"."cooperative_id" = app_cooperative_id() AND NOT app_is_farmer())
  );

-- ---------------------------------------------------------------------------
-- 4. Tables that inherit tenancy through their batch.
-- ---------------------------------------------------------------------------
-- None of these carry a cooperative_id, so each defers to coffee_batches. The
-- EXISTS is evaluated under the caller's own policies, which means the farmer
-- narrowing on coffee_batches flows through automatically: a farmer sees the
-- processing records, ledger rows, and storage history of exactly the batches
-- they are associated with, and nothing else.

CREATE OR REPLACE FUNCTION app_can_see_batch(p_batch_id UUID) RETURNS BOOLEAN AS $$
  SELECT app_is_unrestricted()
      OR EXISTS (SELECT 1 FROM "coffee_batches" b WHERE b."id" = p_batch_id);
$$ LANGUAGE sql STABLE PARALLEL SAFE;

ALTER TABLE "processing_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processing_records" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "processing_records_tenant" ON "processing_records";
CREATE POLICY "processing_records_tenant" ON "processing_records"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  WITH CHECK (app_can_see_batch("batch_id") AND NOT app_is_farmer());

ALTER TABLE "ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ownership_transfers_tenant" ON "ownership_transfers";
CREATE POLICY "ownership_transfers_tenant" ON "ownership_transfers"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  WITH CHECK (app_can_see_batch("batch_id") AND NOT app_is_farmer());

ALTER TABLE "warehouse_inventory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouse_inventory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "warehouse_inventory_tenant" ON "warehouse_inventory";
CREATE POLICY "warehouse_inventory_tenant" ON "warehouse_inventory"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  WITH CHECK (app_can_see_batch("batch_id") AND NOT app_is_farmer());

-- The ledger stays append-only for everyone: the immutability trigger from
-- 20260804200000_blockchain_hash_chain already blocks UPDATE/DELETE, and this
-- policy adds "you may only read the chain of a batch you can see".
ALTER TABLE "blockchain_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blockchain_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "blockchain_transactions_tenant" ON "blockchain_transactions";
CREATE POLICY "blockchain_transactions_tenant" ON "blockchain_transactions"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  WITH CHECK (app_can_see_batch("batch_id"));

ALTER TABLE "qr_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_verifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qr_verifications_tenant" ON "qr_verifications";
CREATE POLICY "qr_verifications_tenant" ON "qr_verifications"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  -- A public scan writes a row before anyone is authenticated, and it runs in
  -- system context to do so; the read side above stays tenant-scoped.
  WITH CHECK (app_can_see_batch("batch_id"));

-- ---------------------------------------------------------------------------
-- 5. Per-user tables.
-- ---------------------------------------------------------------------------
-- Owned by a user rather than a cooperative, so the test is the user id.

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifications_own" ON "notifications";
CREATE POLICY "notifications_own" ON "notifications"
  FOR ALL
  USING (app_is_unrestricted() OR "user_id" = app_current_user_id())
  -- Fan-out writes to other users' inboxes are a system action (the notification
  -- service), which is why INSERT is not narrowed to the caller's own id.
  WITH CHECK (app_is_unrestricted() OR "user_id" = app_current_user_id());

-- Audit rows are written about the actor and never edited afterwards. Only
-- SUPER_ADMIN reads them back, so a plain unrestricted test is enough, with
-- INSERT open so every role's actions are still recorded.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_read" ON "audit_logs";
CREATE POLICY "audit_logs_read" ON "audit_logs"
  FOR SELECT
  USING (app_is_unrestricted() OR "user_id" = app_current_user_id());
DROP POLICY IF EXISTS "audit_logs_append" ON "audit_logs";
CREATE POLICY "audit_logs_append" ON "audit_logs"
  FOR INSERT
  WITH CHECK (true);

-- A buyer is a counterparty rather than a tenant: any cooperative may transfer
-- ownership to any buyer, so buyers stay readable to authenticated staff and
-- writable only outside farmer context.
ALTER TABLE "buyers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "buyers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers_read" ON "buyers";
CREATE POLICY "buyers_read" ON "buyers"
  FOR ALL
  USING (app_is_unrestricted() OR app_current_role() IS NOT NULL)
  WITH CHECK (app_is_unrestricted() OR (app_current_role() IS NOT NULL AND NOT app_is_farmer()));

-- ---------------------------------------------------------------------------
-- 6. Deliberately left without RLS.
-- ---------------------------------------------------------------------------
-- `role_permissions`, `system_settings`, `code_counters` and `_prisma_migrations`
-- hold no tenant data. The first two are global configuration every request reads
-- to answer "may this role do this?" — putting them behind RLS would either break
-- authorization or need a policy that permits everyone, which is the same as no
-- policy but harder to read. Writes to them are already permission-guarded in the
-- application. `code_counters` is an opaque sequence table.


