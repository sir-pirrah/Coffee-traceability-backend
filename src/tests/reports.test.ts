import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";
import { invalidate } from "@/modules/permissions/permission.service";

const API = env.API_PREFIX;

/**
 * The six cooperative reports, end to end. Each report is asserted three ways:
 *   - shape + exact computed values (yield %, capacity %, totals, averages),
 *   - RBAC (who may open it — the Sales Ledger is Admin-only),
 *   - tenant/self scoping (a farmer sees only their rows; a neighbour coop none).
 *
 * The coop-A fixture is rebuilt deterministically on every run: beforeAll deletes
 * any leftover transactional rows first, so counts like "2 deliveries / 200 kg"
 * are exact rather than accumulating across reruns.
 */
describeIfDb("reports", () => {
  let app: Express;
  let cooperativeId: string; // coop A — the reports' cooperative
  let otherCooperativeId: string; // coop B — the intruder's cooperative

  let adminUserId: string; // COOPERATIVE_ADMIN — full access incl. financial
  let staffUserId: string; // COOPERATIVE_STAFF — reports:view, no financial
  let auditorUserId: string; // AUDITOR — reports:view, no financial
  let farmerUserId: string; // FARMER — deliveries:view, self-scoped
  let intruderUserId: string; // COOPERATIVE_ADMIN of coop B

  let mineFarmerId: string; // farmer linked to farmerUserId
  let theirFarmerId: string; // book-only farmer, no login
  let batchId: string;
  let warehouseId: string;

  const admin = () => ({ id: adminUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId });
  const staff = () => ({ id: staffUserId, role: "COOPERATIVE_STAFF" as const, cooperativeId });
  const auditor = () => ({ id: auditorUserId, role: "AUDITOR" as const, cooperativeId });
  const farmer = () => ({ id: farmerUserId, role: "FARMER" as const, cooperativeId });
  const intruder = () => ({ id: intruderUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId: otherCooperativeId });

  beforeAll(
    asSystem(async () => {
      app = createApp();

      const coop = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-RPT-A" },
        update: {},
        create: { name: "Report Coop A", registrationNo: "TEST-COOP-RPT-A", county: "Nyeri" },
      });
      const other = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-RPT-B" },
        update: {},
        create: { name: "Report Coop B", registrationNo: "TEST-COOP-RPT-B", county: "Kiambu" },
      });
      cooperativeId = coop.id;
      otherCooperativeId = other.id;

      // Wipe any leftovers so coop A holds exactly this fixture (exact counts).
      const existing = await prisma.coffeeBatch.findMany({ where: { cooperativeId }, select: { id: true } });
      const staleBatchIds = existing.map((b) => b.id);
      if (staleBatchIds.length) {
        await prisma.ownershipTransfer.deleteMany({ where: { batchId: { in: staleBatchIds } } });
        await prisma.warehouseInventory.deleteMany({ where: { batchId: { in: staleBatchIds } } });
        await prisma.processingRecord.deleteMany({ where: { batchId: { in: staleBatchIds } } });
      }
      await prisma.delivery.deleteMany({ where: { cooperativeId } });
      await prisma.warehouse.deleteMany({ where: { cooperativeId } });
      if (staleBatchIds.length) await prisma.coffeeBatch.deleteMany({ where: { id: { in: staleBatchIds } } });

      const mkUser = (email: string, role: "COOPERATIVE_ADMIN" | "COOPERATIVE_STAFF" | "AUDITOR" | "FARMER", coopId: string) =>
        prisma.user.upsert({
          where: { email },
          update: { cooperativeId: coopId, role },
          create: {
            email,
            passwordHash: "not-used-tokens-are-signed-directly",
            firstName: "Report",
            lastName: role,
            role,
            status: "ACTIVE",
            cooperativeId: coopId,
          },
        });

      adminUserId = (await mkUser("rpt-admin@test.local", "COOPERATIVE_ADMIN", cooperativeId)).id;
      staffUserId = (await mkUser("rpt-staff@test.local", "COOPERATIVE_STAFF", cooperativeId)).id;
      auditorUserId = (await mkUser("rpt-auditor@test.local", "AUDITOR", cooperativeId)).id;
      farmerUserId = (await mkUser("rpt-farmer@test.local", "FARMER", cooperativeId)).id;
      intruderUserId = (await mkUser("rpt-intruder@test.local", "COOPERATIVE_ADMIN", otherCooperativeId)).id;

      const mine = await prisma.farmer.upsert({
        where: { farmerCode: "TEST-RPT-FARMER-MINE" },
        update: { userId: farmerUserId, cooperativeId, isDeleted: false, isActive: true },
        create: {
          farmerCode: "TEST-RPT-FARMER-MINE",
          firstName: "Mine",
          lastName: "Farmer",
          cooperativeId,
          userId: farmerUserId,
        },
      });
      mineFarmerId = mine.id;

      const theirs = await prisma.farmer.upsert({
        where: { farmerCode: "TEST-RPT-FARMER-THEIRS" },
        update: { cooperativeId, isDeleted: false, isActive: true },
        create: { farmerCode: "TEST-RPT-FARMER-THEIRS", firstName: "Their", lastName: "Farmer", cooperativeId },
      });
      theirFarmerId = theirs.id;

      const batch = await prisma.coffeeBatch.create({
        data: {
          batchCode: "TEST-RPT-BATCH",
          cooperativeId,
          qrCodeToken: "test-rpt-batch-token",
          status: "REGISTERED",
          originRegion: "Mathira",
          harvestSeason: "2026-early",
          totalWeightKg: 200,
        },
      });
      batchId = batch.id;

      // 2 deliveries → 200 kg total, avg 100 kg/delivery.
      await prisma.delivery.create({
        data: {
          deliveryCode: "TEST-RPT-DEL-MINE",
          farmerId: mineFarmerId,
          cooperativeId,
          weightKg: 120,
          pricePerKg: 50, // value 6000
          qualityGrade: "AA",
          deliveryDate: new Date("2026-01-15"),
          batchId,
        },
      });
      await prisma.delivery.create({
        data: {
          deliveryCode: "TEST-RPT-DEL-THEIRS",
          farmerId: theirFarmerId,
          cooperativeId,
          weightKg: 80,
          pricePerKg: 45, // value 3600
          qualityGrade: "AB",
          deliveryDate: new Date("2026-01-20"),
          batchId,
        },
      });

      // Processing: 200 kg in → 160 kg out = 80% yield, over 4 days.
      await prisma.processingRecord.create({
        data: {
          batchId,
          method: "WASHED",
          startDate: new Date("2026-02-01"),
          endDate: new Date("2026-02-05"),
          outputWeightKg: 160,
        },
      });

      const warehouse = await prisma.warehouse.create({
        data: { cooperativeId, name: "Main Store", location: "Nyeri Town", capacityKg: 1000 },
      });
      warehouseId = warehouse.id;
      // 160 kg stored against 1000 kg capacity = 16% used.
      await prisma.warehouseInventory.create({
        data: { warehouseId, batchId, weightKg: 160, storedAt: new Date("2026-01-10") },
      });

      let buyer = await prisma.buyer.findFirst({ where: { companyName: "Acme Importers (TEST-RPT)" } });
      if (!buyer) {
        buyer = await prisma.buyer.create({ data: { companyName: "Acme Importers (TEST-RPT)", country: "USA" } });
      }
      // Confirmed 300/kg × 200 kg = 60000; pending 250/kg × 200 kg = 50000.
      await prisma.ownershipTransfer.create({
        data: {
          batchId,
          fromEntityType: "COOPERATIVE",
          fromEntityId: cooperativeId,
          buyerId: buyer.id,
          salePricePerKg: 300,
          status: "CONFIRMED",
          transferredAt: new Date("2026-03-01"),
        },
      });
      await prisma.ownershipTransfer.create({
        data: {
          batchId,
          fromEntityType: "COOPERATIVE",
          fromEntityId: cooperativeId,
          buyerId: buyer.id,
          salePricePerKg: 250,
          status: "PENDING",
          transferredAt: new Date("2026-02-15"),
        },
      });

      // Grant the reports keys per role. reports:financial goes ONLY to admin —
      // that asymmetry is what the Sales Ledger RBAC tests turn on.
      const grants: Record<string, string[]> = {
        COOPERATIVE_ADMIN: ["reports:view", "reports:financial", "deliveries:view", "blockchain:view"],
        COOPERATIVE_STAFF: ["reports:view", "deliveries:view", "blockchain:view"],
        AUDITOR: ["reports:view", "deliveries:view", "blockchain:view"],
        FARMER: ["deliveries:view"],
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
      invalidate(); // drop the cached matrix so the grants above take effect now
    })
  );

  afterAll(
    asSystem(async () => {
      if (batchId) {
        await prisma.ownershipTransfer.deleteMany({ where: { batchId } });
        await prisma.warehouseInventory.deleteMany({ where: { batchId } });
        await prisma.processingRecord.deleteMany({ where: { batchId } });
        await prisma.delivery.deleteMany({ where: { batchId } });
        await prisma.coffeeBatch.deleteMany({ where: { id: batchId } });
      }
      if (warehouseId) await prisma.warehouse.deleteMany({ where: { id: warehouseId } });
      await prisma.$disconnect();
    })
  );

  // ---------------------------------------------------------------------------
  // Report #1 — Operations Summary
  // ---------------------------------------------------------------------------
  describe("operations summary (#1)", () => {
    it("returns headline figures with the average weight per delivery", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/summary`)
        .set(...authHeader(admin()));

      expect(res.status).toBe(200);
      expect(res.body.data.totalDeliveries).toBe(2);
      expect(res.body.data.totalWeightKg).toBe(200);
      expect(res.body.data.avgWeightPerDelivery).toBe(100);
      expect(res.body.data.activeFarmers).toBe(2);
      expect(res.body.data.batchesByStatus).toContainEqual({ status: "REGISTERED", count: 1 });
    });

    it("is visible to staff too", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/summary`)
        .set(...authHeader(staff()));
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Report #2 — Farmer Delivery Statement
  // ---------------------------------------------------------------------------
  describe("farmer statement (#2)", () => {
    it("gives staff every farmer's row with value = weight × price", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/farmer-statement`)
        .set(...authHeader(staff()));

      expect(res.status).toBe(200);
      const rows = res.body.data.rows as { farmerId: string; totalKg: number; totalValue: number; mostCommonGrade: string }[];
      expect(rows).toHaveLength(2);
      // Sorted by totalKg desc → mine (120) first.
      expect(rows[0].farmerId).toBe(mineFarmerId);
      expect(rows[0].totalKg).toBe(120);
      expect(rows[0].totalValue).toBe(6000);
      expect(rows[0].mostCommonGrade).toBe("AA");
      expect(res.body.data.totals).toEqual({ deliveryCount: 2, totalKg: 200, totalValue: 9600 });
    });

    it("narrows a FARMER to their own row and ignores a forged ?farmerId", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/farmer-statement`)
        .query({ farmerId: theirFarmerId }) // attempt to read a neighbour
        .set(...authHeader(farmer()));

      expect(res.status).toBe(200);
      const rows = res.body.data.rows as { farmerId: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].farmerId).toBe(mineFarmerId);
      expect(JSON.stringify(res.body)).not.toContain("TEST-RPT-FARMER-THEIRS");
    });
  });

  // ---------------------------------------------------------------------------
  // Report #3 — Batch Traceability Sheet (+ PDF)
  // ---------------------------------------------------------------------------
  describe("batch traceability (#3)", () => {
    it("consolidates the batch journey with a blockchain confirmation", async () => {
      const res = await request(app)
        .get(`${API}/reports/batch/${batchId}/traceability`)
        .set(...authHeader(admin()));

      expect(res.status).toBe(200);
      const sheet = res.body.data;
      expect(sheet.batchCode).toBe("TEST-RPT-BATCH");
      expect(sheet.originRegion).toBe("Mathira");
      expect(sheet.totalWeightKg).toBe(200);
      expect(sheet.deliveries).toHaveLength(2);
      expect(sheet.processing).toHaveLength(1);
      expect(sheet.warehouseHistory).toHaveLength(1);
      expect(sheet.sales).toHaveLength(2);
      // A batch with no directly-inserted chain events verifies as intact/empty.
      expect(sheet.blockchain.chainValid).toBe(true);
      expect(sheet.blockchain.confirmedEvents).toBe(0);
    });

    it("is open to an auditor (read-only role)", async () => {
      const res = await request(app)
        .get(`${API}/reports/batch/${batchId}/traceability`)
        .set(...authHeader(auditor()));
      expect(res.status).toBe(200);
    });

    it("streams a PDF export", async () => {
      const res = await request(app)
        .get(`${API}/reports/batch/${batchId}/traceability.pdf`)
        .set(...authHeader(admin()))
        .buffer(true)
        .parse((response, cb) => {
          const chunks: Buffer[] = [];
          response.on("data", (c: Buffer) => chunks.push(c));
          response.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toContain("attachment");
      const body = res.body as Buffer;
      expect(body.length).toBeGreaterThan(0);
      expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    });
  });

  // ---------------------------------------------------------------------------
  // Report #4 — Processing Yield
  // ---------------------------------------------------------------------------
  describe("processing yield (#4)", () => {
    it("computes yield % from batch weight in vs output out", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/processing-yield`)
        .set(...authHeader(admin()));

      expect(res.status).toBe(200);
      const rows = res.body.data.rows as { batchCode: string; inputKg: number; outputKg: number; yieldPct: number; durationDays: number; inProgress: boolean }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].inputKg).toBe(200);
      expect(rows[0].outputKg).toBe(160);
      expect(rows[0].yieldPct).toBe(80);
      expect(rows[0].durationDays).toBe(4);
      expect(rows[0].inProgress).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Report #5 — Warehouse Inventory Snapshot
  // ---------------------------------------------------------------------------
  describe("warehouse inventory (#5)", () => {
    it("reports stored weight and capacity used %", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/warehouse-inventory`)
        .set(...authHeader(admin()));

      expect(res.status).toBe(200);
      const rows = res.body.data.rows as { warehouseName: string; batchesStored: number; storedWeightKg: number; capacityUsedPct: number; items: { daysInStorage: number }[] }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].batchesStored).toBe(1);
      expect(rows[0].storedWeightKg).toBe(160);
      expect(rows[0].capacityUsedPct).toBe(16);
      expect(rows[0].items[0].daysInStorage).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Report #6 — Sales & Transfer Ledger (Admin only)
  // ---------------------------------------------------------------------------
  describe("sales ledger (#6)", () => {
    it("totals confirmed and pending value for an admin", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/sales-ledger`)
        .set(...authHeader(admin()));

      expect(res.status).toBe(200);
      expect(res.body.data.rows).toHaveLength(2);
      expect(res.body.data.totals.confirmedValue).toBe(60000);
      expect(res.body.data.totals.pendingValue).toBe(50000);
    });

    it("is forbidden to staff (no reports:financial)", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/sales-ledger`)
        .set(...authHeader(staff()));
      expect(res.status).toBe(403);
    });

    it("is forbidden to an auditor (financial key is not a :view key)", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/sales-ledger`)
        .set(...authHeader(auditor()));
      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------
  describe("tenant isolation", () => {
    it("hides another cooperative's batch behind a 404 (batch-keyed)", async () => {
      const res = await request(app)
        .get(`${API}/reports/batch/${batchId}/traceability`)
        .set(...authHeader(intruder()));

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("TEST-RPT-BATCH");
    });

    it("refuses a coop-keyed report for a cooperative the caller doesn't own (403)", async () => {
      const res = await request(app)
        .get(`${API}/reports/cooperative/${cooperativeId}/summary`)
        .set(...authHeader(intruder()));

      expect(res.status).toBe(403);
    });

    it("refuses the PDF export of another cooperative's batch (404)", async () => {
      const res = await request(app)
        .get(`${API}/reports/batch/${batchId}/traceability.pdf`)
        .set(...authHeader(intruder()));

      expect(res.status).toBe(404);
    });
  });
});
