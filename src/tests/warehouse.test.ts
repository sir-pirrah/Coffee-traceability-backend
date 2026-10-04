import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";
import { runAsSystem } from "@/repositories/dbContext";
import { invalidate } from "@/modules/permissions/permission.service";

const API = env.API_PREFIX;

/**
 * Warehouse storage is the one action that creates the `warehouse_inventory`
 * row the "In Storage" KPI, the warehouse snapshot report, and the movement
 * chart all read, so every guard that keeps that number honest lives on the
 * store route. This suite exercises them together:
 *
 *   - capacity: a store may not overfill the warehouse (nor a null-capacity one
 *     be silently capped at zero),
 *   - double-storage: a batch may hold only one open inventory row,
 *   - weight: a store may not claim more coffee than the batch contains,
 *   - lifecycle: storing is a status transition, not a free write,
 *   - check-out: `/remove` closes the row without moving the batch's status,
 *   - auto-close: a confirming sale closes the row, so the KPI drops.
 *
 * Requests go through the real middleware stack (supertest), so RLS and the
 * permission matrix apply exactly as in production. Only fixtures — and the
 * assertion-side reads below — use the system context: anything outside the
 * request pipeline carries an empty identity, which every policy correctly
 * reads as "matches no rows".
 */
describeIfDb("warehouse storage guards", () => {
  let app: Express;

  let cooperativeId: string;
  let otherCooperativeId: string;
  let staffUserId: string;
  let intruderUserId: string;
  let auditorUserId: string;

  let smallWarehouseId: string; // capacity 100 kg
  let openWarehouseId: string; // capacity null == unlimited
  let otherWarehouseId: string; // belongs to the other cooperative

  const staff = () => ({ id: staffUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId });
  const intruder = () => ({ id: intruderUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId: otherCooperativeId });
  // COOPERATIVE_STAFF is granted warehouse:view AND warehouse:store/remove in
  // the default matrix, so a staffer is the wrong identity for a "lacks the
  // permission" assertion. AUDITOR holds only the `:view` keys, which is a role
  // that genuinely cannot store or check out.
  const auditor = () => ({ id: auditorUserId, role: "AUDITOR" as const, cooperativeId });

  const tag = Date.now().toString(36);
  const batchCode = (label: string) => `TEST-WH-${label}-${tag}`;

  /**
   * A batch sitting at PROCESSED — the status storage is entered from.
   *
   * Fixture writes bypass the request pipeline, so they carry an empty RLS
   * context and would be rejected (as any seed script would be); `runAsSystem`
   * is the same escape hatch the fixture setup uses.
   */
  async function mkBatch(label: string, totalWeightKg: number, status: "PROCESSED" | "REGISTERED" = "PROCESSED") {
    return runAsSystem(() =>
      prisma.coffeeBatch.create({
        data: {
          batchCode: batchCode(label),
          qrCodeToken: `wh-${label}-${tag}`,
          cooperativeId,
          status,
          totalWeightKg,
        },
      })
    );
  }

  const createdBatchIds: string[] = [];

  beforeAll(
    asSystem(async () => {
      app = createApp();

      const coop = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-WH-A" },
        update: {},
        create: { name: "Warehouse Coop A", registrationNo: "TEST-COOP-WH-A", county: "Nyeri" },
      });
      const other = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-WH-B" },
        update: {},
        create: { name: "Warehouse Coop B", registrationNo: "TEST-COOP-WH-B", county: "Kiambu" },
      });
      cooperativeId = coop.id;
      otherCooperativeId = other.id;

      const mkUser = async (email: string, role: "COOPERATIVE_ADMIN" | "COOPERATIVE_STAFF" | "AUDITOR", coopId: string) =>
        (
          await prisma.user.upsert({
            where: { email },
            update: { cooperativeId: coopId, role },
            create: {
              email,
              passwordHash: "not-used-tokens-are-signed-directly",
              firstName: "Ware",
              lastName: "House",
              role,
              status: "ACTIVE",
              cooperativeId: coopId,
            },
          })
        ).id;

      staffUserId = await mkUser("wh-staff@test.local", "COOPERATIVE_ADMIN", cooperativeId);
      auditorUserId = await mkUser("wh-auditor@test.local", "AUDITOR", cooperativeId);
      intruderUserId = await mkUser("wh-intruder@test.local", "COOPERATIVE_ADMIN", otherCooperativeId);

      // Warehouses are upserted by (cooperative, name) via a find-then-create,
      // so reruns reuse the same rows rather than piling up duplicates.
      const mkWarehouse = async (coopId: string, name: string, capacityKg: number | null) => {
        const existing = await prisma.warehouse.findFirst({ where: { cooperativeId: coopId, name } });
        if (existing) return existing.id;
        const created = await prisma.warehouse.create({ data: { cooperativeId: coopId, name, capacityKg } });
        return created.id;
      };

      smallWarehouseId = await mkWarehouse(cooperativeId, "Small Store (TEST-WH)", 100);
      openWarehouseId = await mkWarehouse(cooperativeId, "Open Store (TEST-WH)", null);
      otherWarehouseId = await mkWarehouse(otherCooperativeId, "Their Store (TEST-WH)", 500);

      // Clear inventory left by an interrupted prior run so capacity math starts
      // from an empty warehouse. Transfers are excluded from this wipe — a
      // confirmed transfer is history we don't need to erase between suites.
      await prisma.warehouseInventory.deleteMany({
        where: { warehouseId: { in: [smallWarehouseId, openWarehouseId, otherWarehouseId].filter(Boolean) } },
      });

      // The permission matrix lives in the DB; make sure the acting role can
      // store and check out. COOPERATIVE_STAFF legitimately holds both in the
      // default matrix, so the "lacks the permission" cases below lean on
      // AUDITOR, which holds only `:view` keys; its `warehouse:view` is ensured
      // so the 403 is the permission guard rejecting, not a missing view right.
      const grants: Record<string, string[]> = {
        COOPERATIVE_ADMIN: ["warehouse:create", "warehouse:view", "warehouse:store", "warehouse:remove"],
        AUDITOR: ["warehouse:view"],
      };
      for (const [role, permissions] of Object.entries(grants)) {
        for (const permission of permissions) {
          await prisma.rolePermission.upsert({
            where: { role_permission: { role: role as never, permission } },
            update: {},
            create: { role: role as never, permission },
          });
        }
      }
      invalidate(); // drop the cached matrix so the grants take effect now
    })
  );

  afterAll(
    asSystem(async () => {
      if (createdBatchIds.length) {
        // Open inventory rows are removed so a rerun's capacity math starts
        // clean; closed rows are left as history.
        await prisma.warehouseInventory.deleteMany({
          where: { batchId: { in: createdBatchIds }, removedAt: null },
        });
        // The batches themselves are soft-deleted, never dropped: every store
        // wrote a `blockchain_transactions` row, and the immutability trigger
        // rejects DELETE on the ledger (and on the batch it hangs from). This is
        // the same convention `batchLifecycle.test.ts` uses.
        await prisma.coffeeBatch.updateMany({
          where: { id: { in: createdBatchIds } },
          data: { isDeleted: true },
        });
      }
      await prisma.$disconnect();
    })
  );

  const store = (warehouseId: string, batchId: string, weightKg: number, who = staff()) =>
    request(app).post(`${API}/warehouses/store`).set(...authHeader(who)).send({ warehouseId, batchId, weightKg });

  describe("capacity", () => {
    it("stores a batch that fits and creates an open inventory row", async () => {
      const batch = await mkBatch("FIT", 80);
      createdBatchIds.push(batch.id);

      const res = await store(smallWarehouseId, batch.id, 60);

      expect(res.status).toBe(201);
      expect(Number(res.body.data.weightKg)).toBe(60);

      const stored = await runAsSystem(() =>
        prisma.warehouseInventory.findFirstOrThrow({ where: { batchId: batch.id } })
      );
      expect(stored.removedAt).toBeNull();
    });

    it("rejects a store that would overfill the warehouse, naming the free space", async () => {
      // 60 kg is already in the 100 kg warehouse from the test above; a 45 kg
      // batch needs 45 of the remaining 40.
      const batch = await mkBatch("OVER", 90);
      createdBatchIds.push(batch.id);

      const res = await store(smallWarehouseId, batch.id, 45);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/space left/i);
      expect(res.body.error.message).toMatch(/40/); // the computed free space
    });

    it("leaves no row behind after a rejected store", async () => {
      const batch = await runAsSystem(() =>
        prisma.coffeeBatch.findFirst({ where: { batchCode: batchCode("OVER") } })
      );
      const rows = await runAsSystem(() =>
        prisma.warehouseInventory.count({ where: { batchId: batch!.id } })
      );
      expect(rows).toBe(0);
    });

    it("treats a null capacity as unlimited", async () => {
      const batch = await mkBatch("OPEN", 5000);
      createdBatchIds.push(batch.id);

      // Far more than the small warehouse could hold, but this one declares no
      // limit — an operator who never set a capacity must not be capped at zero.
      const res = await store(openWarehouseId, batch.id, 4000);

      expect(res.status).toBe(201);
      expect(Number(res.body.data.weightKg)).toBe(4000);
    });
  });

  describe("double storage", () => {
    it("refuses to store a batch that already has an open inventory row", async () => {
      const batch = await mkBatch("TWICE", 100);
      createdBatchIds.push(batch.id);

      const first = await store(openWarehouseId, batch.id, 40);
      expect(first.status).toBe(201);

      const second = await store(openWarehouseId, batch.id, 40);
      expect(second.status).toBe(400);
      expect(second.body.error.message).toMatch(/already stored/i);

      // Still exactly one open row — the second store wrote nothing.
      const open = await runAsSystem(() =>
        prisma.warehouseInventory.count({ where: { batchId: batch.id, removedAt: null } })
      );
      expect(open).toBe(1);
    });

    it("allows a re-store once the previous row is checked out", async () => {
      const batch = await mkBatch("RESTORE", 100);
      createdBatchIds.push(batch.id);

      const first = await store(openWarehouseId, batch.id, 40);
      expect(first.status).toBe(201);

      const removed = await request(app)
        .post(`${API}/warehouses/${first.body.data.id}/remove`)
        .set(...authHeader(staff()));
      expect(removed.status).toBe(200);

      const again = await store(openWarehouseId, batch.id, 30);
      expect(again.status).toBe(201);
    });
  });

  describe("stored weight", () => {
    it("refuses to store more than the batch holds", async () => {
      const batch = await mkBatch("WEIGHT", 50);
      createdBatchIds.push(batch.id);

      const res = await store(openWarehouseId, batch.id, 75);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/only holds 50/i);
    });

    it("accepts a store that exactly fills the batch", async () => {
      const batch = await mkBatch("EXACT", 42);
      createdBatchIds.push(batch.id);

      const res = await store(openWarehouseId, batch.id, 42);
      expect(res.status).toBe(201);
    });
  });

  describe("lifecycle", () => {
    it("refuses to store a batch that was never processed", async () => {
      const batch = await mkBatch("UNPROC", 100, "REGISTERED");
      createdBatchIds.push(batch.id);

      const res = await store(openWarehouseId, batch.id, 10);

      // REGISTERED -> IN_STORAGE is not an edge in the state machine.
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/from REGISTERED to IN_STORAGE/i);
    });

    it("moves the batch to IN_STORAGE on a successful store", async () => {
      const batch = await mkBatch("STATUS", 100);
      createdBatchIds.push(batch.id);

      const res = await store(openWarehouseId, batch.id, 25);
      expect(res.status).toBe(201);

      const after = await runAsSystem(() =>
        prisma.coffeeBatch.findUniqueOrThrow({ where: { id: batch.id } })
      );
      expect(after.status).toBe("IN_STORAGE");
    });
  });

  describe("check-out", () => {
    it("sets removedAt without moving the batch's status", async () => {
      const batch = await mkBatch("OUT", 100);
      createdBatchIds.push(batch.id);

      const stored = await store(openWarehouseId, batch.id, 30);
      const inventoryId = stored.body.data.id;

      const res = await request(app)
        .post(`${API}/warehouses/${inventoryId}/remove`)
        .set(...authHeader(staff()));

      expect(res.status).toBe(200);
      expect(res.body.data.removedAt).not.toBeNull();

      // The row is closed, but the batch is still IN_STORAGE — check-out is the
      // warehouse's record of custody, not a lifecycle transition.
      const after = await runAsSystem(() =>
        prisma.coffeeBatch.findUniqueOrThrow({ where: { id: batch.id } })
      );
      expect(after.status).toBe("IN_STORAGE");
    });

    it("reports a second check-out rather than silently doing nothing", async () => {
      const batch = await mkBatch("OUT2", 100);
      createdBatchIds.push(batch.id);

      const stored = await store(openWarehouseId, batch.id, 30);
      const inventoryId = stored.body.data.id;

      await request(app).post(`${API}/warehouses/${inventoryId}/remove`).set(...authHeader(staff()));
      const second = await request(app)
        .post(`${API}/warehouses/${inventoryId}/remove`)
        .set(...authHeader(staff()));

      expect(second.status).toBe(400);
      expect(second.body.error.message).toMatch(/already checked out/i);
    });
  });

  describe("auto-close on exit", () => {
    it("closes the open row when a confirming sale marks the batch SOLD", async () => {
      const batch = await mkBatch("SOLD", 100);
      createdBatchIds.push(batch.id);

      const stored = await store(openWarehouseId, batch.id, 55);
      expect(stored.status).toBe(201);

      // A sale is a confirmed ownership transfer, not a status write. Buyers are
      // global reference rows with no RLS tenancy, but `buyer` has no unique key
      // on companyName, so upsert-by-name is not available — find first, create
      // if missing. Fixture writes still go through the system context.
      const buyer = await runAsSystem(async () => {
        const existing = await prisma.buyer.findFirst({ where: { companyName: "WH Test Buyer" } });
        if (existing) return existing;
        return prisma.buyer.create({ data: { companyName: "WH Test Buyer", country: "Kenya" } });
      });

      const transfer = await request(app)
        .post(`${API}/ownership-transfers`)
        .set(...authHeader(staff()))
        .send({
          batchId: batch.id,
          fromEntityType: "COOPERATIVE",
          fromEntityId: cooperativeId,
          buyerId: buyer.id,
        });
      expect(transfer.status).toBe(201);

      const confirmed = await request(app)
        .post(`${API}/ownership-transfers/${transfer.body.data.id}/confirm`)
        .set(...authHeader(staff()));
      expect(confirmed.status).toBe(200);

      // The sale transitions SOLD through the shared chokepoint, which closes
      // active inventory in the same transaction.
      const after = await runAsSystem(() =>
        prisma.coffeeBatch.findUniqueOrThrow({ where: { id: batch.id } })
      );
      expect(after.status).toBe("SOLD");

      const open = await runAsSystem(() =>
        prisma.warehouseInventory.count({ where: { batchId: batch.id, removedAt: null } })
      );
      expect(open).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("does not let another cooperative store a batch it cannot see", async () => {
      const batch = await mkBatch("ISO", 100);
      createdBatchIds.push(batch.id);

      // RLS drops the batch before the handler's ownership check, so the
      // intruder cannot even tell the id exists.
      const res = await store(openWarehouseId, batch.id, 10, intruder());
      expect(res.status).toBe(404);
    });

    it("refuses to store into a warehouse of another cooperative", async () => {
      const batch = await mkBatch("ISOWH", 100);
      createdBatchIds.push(batch.id);

      // The warehouse is invisible to the intruder for the same reason.
      const res = await store(otherWarehouseId, batch.id, 10, intruder());
      expect(res.status).toBe(404);
    });

    it("refuses to check out another cooperative's inventory row", async () => {
      const batch = await mkBatch("ISOREM", 100);
      createdBatchIds.push(batch.id);

      const stored = await store(openWarehouseId, batch.id, 10);
      const res = await request(app)
        .post(`${API}/warehouses/${stored.body.data.id}/remove`)
        .set(...authHeader(intruder()));

      expect(res.status).toBe(404);
    });
  });

  describe("permissions", () => {
    it("forbids a role without warehouse:store", async () => {
      const batch = await mkBatch("PERM", 100);
      createdBatchIds.push(batch.id);

      const res = await store(openWarehouseId, batch.id, 10, auditor());
      expect(res.status).toBe(403);

      const open = await runAsSystem(() =>
        prisma.warehouseInventory.count({ where: { batchId: batch.id } })
      );
      expect(open).toBe(0);
    });

    it("forbids a role without warehouse:remove", async () => {
      const batch = await mkBatch("PERM2", 100);
      createdBatchIds.push(batch.id);

      const stored = await store(openWarehouseId, batch.id, 10);
      const res = await request(app)
        .post(`${API}/warehouses/${stored.body.data.id}/remove`)
        .set(...authHeader(auditor()));

      expect(res.status).toBe(403);
    });
  });
});
