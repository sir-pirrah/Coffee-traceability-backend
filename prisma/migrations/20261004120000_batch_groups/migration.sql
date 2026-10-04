-- CreateEnum
CREATE TYPE "BatchGroupStatus" AS ENUM ('OPEN', 'SOLD');

-- CreateTable
CREATE TABLE "batch_groups" (
    "id" UUID NOT NULL,
    "group_code" TEXT NOT NULL,
    "cooperative_id" UUID NOT NULL,
    "note" TEXT,
    "status" "BatchGroupStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "batch_groups_group_code_key" ON "batch_groups"("group_code");

-- CreateIndex
CREATE INDEX "batch_groups_cooperative_id_idx" ON "batch_groups"("cooperative_id");

-- CreateIndex
CREATE INDEX "batch_group_members_group_id_idx" ON "batch_group_members"("group_id");

-- CreateIndex
CREATE INDEX "batch_group_members_batch_id_idx" ON "batch_group_members"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "batch_group_members_group_id_batch_id_key" ON "batch_group_members"("group_id", "batch_id");

-- AddForeignKey
ALTER TABLE "batch_groups" ADD CONSTRAINT "batch_groups_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_groups" ADD CONSTRAINT "batch_groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_group_members" ADD CONSTRAINT "batch_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "batch_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_group_members" ADD CONSTRAINT "batch_group_members_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security -----------------------------------------------------------
--
-- Both tables live under FORCE ROW LEVEL SECURITY like every other tenant table.
-- The app connects as an unprivileged role that cannot bypass RLS, so a new
-- table that is NOT given a policy here is invisible to the app entirely — and,
-- worse, a table left with RLS *disabled* would be a cross-tenant hole. These
-- blocks mirror the warehouses / warehouse_inventory policies exactly.

-- batch_groups carries its own cooperative_id, so it scopes like `warehouses`:
-- visible to the owning cooperative's non-farmer staff, and to unrestricted
-- callers (system context / SUPER_ADMIN).
ALTER TABLE "batch_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batch_groups_tenant" ON "batch_groups";
CREATE POLICY "batch_groups_tenant" ON "batch_groups"
  FOR ALL
  USING (app_is_unrestricted() OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer()))
  WITH CHECK (app_is_unrestricted() OR (cooperative_id = app_cooperative_id() AND NOT app_is_farmer()));

-- batch_group_members has no cooperative_id of its own; it is reachable only
-- through a batch the caller can already see, so it scopes via the batch exactly
-- like `warehouse_inventory`. Writes are additionally denied to farmers.
ALTER TABLE "batch_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_group_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batch_group_members_tenant" ON "batch_group_members";
CREATE POLICY "batch_group_members_tenant" ON "batch_group_members"
  FOR ALL
  USING (app_can_see_batch("batch_id"))
  WITH CHECK (app_can_see_batch("batch_id") AND NOT app_is_farmer());
