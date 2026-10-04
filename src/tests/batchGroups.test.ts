import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { BatchStatus } from "@prisma/client";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader, type TestIdentity } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";
import { runAsSystem } from "@/repositories/dbContext";
import { invalidate } from "@/modules/permissions/permission.service";

const API = env.API_PREFIX;

/**
 * Batch groups ("lots") combine several batches so they can be sold as a unit
 * WITHOUT consuming the originals: a member keeps its own identity, status, and
 * per-batch ledger. This suite proves that contract end to end —
 *
 *   - create: ownership-scoped, two-or-more batches, no terminal members,
 *   - sell: fans out exactly one PENDING transfer per member,
 *   - confirm-sale: finalises every member — each flips to SOLD with its own
 *     OWNERSHIP_TRANSFERRED / SALE_RECORDED events, and stays independently
 *     traceable,
 *   - tenant isolation and the lots:view / lots:manage permission split.
 *
 * Requests go through the real middleware stack (supertest), so RLS and the
 * permission matrix apply exactly as in production. Only fixtures and the
 * assertion-side reads use the system context.
 */
describeIfDb("batch groups (lots)", () => {
  let app: Express;

  let cooperativeId: string;
  let otherCooperativeId: string;
  let staffUserId: string;
  let intruderUserId: string;
  let auditorUserId: string;
  let buyerId: string;

  // Typed as TestIdentity so the request helpers below accept any role without
  // TypeScript narrowing the parameter to the first factory's role literal.
  const staff = (): TestIdentity => ({ id: staffUserId, role: "COOPERATIVE_ADMIN", cooperativeId });
  const intruder = (): TestIdentity => ({ id: intruderUserId, role: "COOPERATIVE_ADMIN", cooperativeId: otherCooperativeId });
  // AUDITOR holds only the `:view` keys, so it is the role that genuinely cannot
  // create or sell a lot — the right identity for the "lacks permission" cases.
  const auditor = (): TestIdentity => ({ id: auditorUserId, role: "AUDITOR", cooperativeId });

  const tag = Date.now().toString(36);
  const batchCode = (label: string) => `TEST-BG-${label}-${tag}`;

  const createdBatchIds: string[] = [];
  const createdGroupIds: string[] = [];

  /**
   * A batch created directly at a chosen status. Fixture writes bypass the
   * request pipeline, so they carry an empty RLS context and run under
   * `runAsSystem`, the same escape hatch the seed script uses.
   */
  async function mkBatch(label: string, totalWeightKg: number, opts: { status?: BatchStatus; coopId?: string } = {}) {
    const batch = await runAsSystem(() =>
      prisma.coffeeBatch.create({
        data: {
          batchCode: batchCode(label),
          qrCodeToken: `bg-${label}-${tag}`,
          cooperativeId: opts.coopId ?? cooperativeId,
          status: opts.status ?? "IN_STORAGE",
          totalWeightKg,
        },
      })
    );
    createdBatchIds.push(batch.id);
    return batch;
  }

  beforeAll(
    asSystem(async () => {
      app = createApp();

      const coop = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-BG-A" },
        update: {},
        create: { name: "Lots Coop A", registrationNo: "TEST-COOP-BG-A", county: "Nyeri" },
      });
      const other = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-BG-B" },
        update: {},
        create: { name: "Lots Coop B", registrationNo: "TEST-COOP-BG-B", county: "Kiambu" },
      });
      cooperativeId = coop.id;
      otherCooperativeId = other.id;

      const mkUser = async (email: string, role: "COOPERATIVE_ADMIN" | "AUDITOR", coopId: string) =>
        (
          await prisma.user.upsert({
            where: { email },
            update: { cooperativeId: coopId, role },
            create: {
              email,
              passwordHash: "not-used-tokens-are-signed-directly",
              firstName: "Lot",
              lastName: "Owner",
              role,
              status: "ACTIVE",
              cooperativeId: coopId,
            },
          })
        ).id;

      staffUserId = await mkUser("bg-staff@test.local", "COOPERATIVE_ADMIN", cooperativeId);
      auditorUserId = await mkUser("bg-auditor@test.local", "AUDITOR", cooperativeId);
      intruderUserId = await mkUser("bg-intruder@test.local", "COOPERATIVE_ADMIN", otherCooperativeId);

      // Buyers are global reference rows with no RLS tenancy; companyName has no
      // unique key, so find-first-then-create rather than upsert.
      const existingBuyer = await prisma.buyer.findFirst({ where: { companyName: "BG Test Buyer" } });
      buyerId = existingBuyer?.id ?? (await prisma.buyer.create({ data: { companyName: "BG Test Buyer", country: "Kenya" } })).id;

      // The permission matrix lives in the DB. COOPERATIVE_ADMIN gets both lot
      // keys; AUDITOR gets only lots:view so its create/sell attempts are
      // rejected by the permission guard, not a missing view right.
      const grants: Record<string, string[]> = {
        COOPERATIVE_ADMIN: ["lots:view", "lots:manage"],
        AUDITOR: ["lots:view"],
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
      // Groups carry no immutability trigger, so they can be dropped outright;
      // members cascade on the group delete.
      if (createdGroupIds.length) {
        await prisma.batchGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
      }
      // Batches that went through a confirmed sale wrote ledger rows, which the
      // immutability trigger refuses to DELETE — soft-delete them instead, the
      // same convention the other DB suites use.
      if (createdBatchIds.length) {
        await prisma.coffeeBatch.updateMany({ where: { id: { in: createdBatchIds } }, data: { isDeleted: true } });
      }
      await prisma.$disconnect();
    })
  );

  const createLot = (batchIds: string[], who: TestIdentity = staff(), note?: string) =>
    request(app).post(`${API}/batch-groups`).set(...authHeader(who)).send({ batchIds, note });

  const sellLot = (id: string, body: Record<string, unknown>, who: TestIdentity = staff()) =>
    request(app).post(`${API}/batch-groups/${id}/sell`).set(...authHeader(who)).send(body);

  const confirmLot = (id: string, who: TestIdentity = staff()) =>
    request(app).post(`${API}/batch-groups/${id}/confirm-sale`).set(...authHeader(who));

  const SALE = { buyerId: "", salePricePerKg: 4.5, fromEntityType: "COOPERATIVE", fromEntityId: "" };
  const sale = () => ({ ...SALE, buyerId, fromEntityId: cooperativeId });

  describe("create", () => {
    it("groups two batches and derives the combined weight on read", async () => {
      const a = await mkBatch("CREATE-A", 80);
      const b = await mkBatch("CREATE-B", 120);

      const res = await createLot([a.id, b.id], staff(), "Export lot");

      expect(res.status).toBe(201);
      createdGroupIds.push(res.body.data.id);
      expect(res.body.data.groupCode).toMatch(/^LOT-\d{4}-\d{5}$/);
      expect(res.body.data.status).toBe("OPEN");
      expect(res.body.data.members).toHaveLength(2);
      // Σ member.totalWeightKg — never stored, so it cannot drift.
      expect(res.body.data.combinedWeightKg).toBe(200);
      // The originals are untouched: still their own batches, not consumed.
      const after = await runAsSystem(() => prisma.coffeeBatch.findUniqueOrThrow({ where: { id: a.id } }));
      expect(after.status).toBe("IN_STORAGE");
    });

    it("rejects a lot of fewer than two batches", async () => {
      const a = await mkBatch("ONE", 50);
      const res = await createLot([a.id]);
      expect(res.status).toBe(400);
    });

    it("rejects duplicate batch ids", async () => {
      const a = await mkBatch("DUP", 50);
      const res = await createLot([a.id, a.id]);
      expect(res.status).toBe(400);
    });

    it("rejects a terminal (sold) batch", async () => {
      const live = await mkBatch("TERM-LIVE", 50);
      const sold = await mkBatch("TERM-SOLD", 50, { status: "SOLD" });

      const res = await createLot([live.id, sold.id]);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cannot be added to a lot/i);
    });

    it("does not let a batch from another cooperative be grouped", async () => {
      const mine = await mkBatch("MIX-MINE", 50);
      const theirs = await mkBatch("MIX-THEIRS", 50, { coopId: otherCooperativeId });

      // RLS hides the other coop's batch from staff(), so it drops out of the
      // lookup and the id is reported missing rather than silently grouped.
      const res = await createLot([mine.id, theirs.id]);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/i);
    });
  });

  describe("read scoping", () => {
    it("hides another cooperative's lot behind a 404", async () => {
      const a = await mkBatch("READ-A", 30);
      const b = await mkBatch("READ-B", 30);
      const created = await createLot([a.id, b.id]);
      createdGroupIds.push(created.body.data.id);

      const mine = await request(app).get(`${API}/batch-groups/${created.body.data.id}`).set(...authHeader(staff()));
      expect(mine.status).toBe(200);
      expect(mine.body.data.combinedWeightKg).toBe(60);

      const theirs = await request(app)
        .get(`${API}/batch-groups/${created.body.data.id}`)
        .set(...authHeader(intruder()));
      expect(theirs.status).toBe(404);
    });
  });

  describe("sell", () => {
    it("fans out exactly one PENDING transfer per member", async () => {
      const a = await mkBatch("SELL-A", 100);
      const b = await mkBatch("SELL-B", 100);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);

      const res = await sellLot(lot.body.data.id, sale());

      expect(res.status).toBe(201);
      expect(res.body.data.transfers).toHaveLength(2);

      const pending = await runAsSystem(() =>
        prisma.ownershipTransfer.findMany({ where: { batchId: { in: [a.id, b.id] }, status: "PENDING" } })
      );
      expect(pending).toHaveLength(2);
      // Selling does not move the batches — status flips only on confirmation.
      const stillStored = await runAsSystem(() => prisma.coffeeBatch.findUniqueOrThrow({ where: { id: a.id } }));
      expect(stillStored.status).toBe("IN_STORAGE");
    });

    it("refuses to sell when a member is not in storage or transit", async () => {
      const stored = await mkBatch("SELL-OK", 100);
      const processed = await mkBatch("SELL-BAD", 100, { status: "PROCESSED" });
      const lot = await createLot([stored.id, processed.id]);
      createdGroupIds.push(lot.body.data.id);

      const res = await sellLot(lot.body.data.id, sale());

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/in storage or in transit/i);
      // Nothing was opened — the whole lot is rejected, not partially sold.
      const pending = await runAsSystem(() =>
        prisma.ownershipTransfer.count({ where: { batchId: { in: [stored.id, processed.id] }, status: "PENDING" } })
      );
      expect(pending).toBe(0);
    });

    it("refuses a second sale while one is still pending", async () => {
      const a = await mkBatch("DBL-A", 100);
      const b = await mkBatch("DBL-B", 100);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);

      expect((await sellLot(lot.body.data.id, sale())).status).toBe(201);

      const second = await sellLot(lot.body.data.id, sale());
      expect(second.status).toBe(400);
      expect(second.body.error.message).toMatch(/already have a pending sale/i);
    });
  });

  describe("confirm-sale", () => {
    it("finalises every member with its own events and marks the lot SOLD", async () => {
      const a = await mkBatch("CONF-A", 100);
      const b = await mkBatch("CONF-B", 150);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);
      expect((await sellLot(lot.body.data.id, sale())).status).toBe(201);

      const res = await confirmLot(lot.body.data.id);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("SOLD");

      // Every member is independently finalised: SOLD, with its own CONFIRMED
      // transfer and its own ledger events — the group did not consume them.
      for (const id of [a.id, b.id]) {
        const batch = await runAsSystem(() => prisma.coffeeBatch.findUniqueOrThrow({ where: { id } }));
        expect(batch.status).toBe("SOLD");

        const confirmed = await runAsSystem(() =>
          prisma.ownershipTransfer.findMany({ where: { batchId: id, status: "CONFIRMED" } })
        );
        expect(confirmed).toHaveLength(1);
        // transferredAt is stamped at confirmation (drives the movement chart).
        expect(confirmed[0].transferredAt).toBeInstanceOf(Date);

        const events = await runAsSystem(() =>
          prisma.blockchainTransaction.findMany({ where: { batchId: id }, select: { eventType: true } })
        );
        const types = events.map((e) => e.eventType);
        expect(types).toContain("OWNERSHIP_TRANSFERRED");
        expect(types).toContain("SALE_RECORDED"); // a price was supplied
      }
    });

    it("rejects confirmation when the lot has no pending sale", async () => {
      const a = await mkBatch("NOPEND-A", 40);
      const b = await mkBatch("NOPEND-B", 40);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);

      const res = await confirmLot(lot.body.data.id);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/no pending sale to confirm/i);
    });
  });

  describe("tenant isolation", () => {
    it("will not sell a lot the caller cannot see", async () => {
      const a = await mkBatch("ISO-A", 100);
      const b = await mkBatch("ISO-B", 100);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);

      const res = await sellLot(lot.body.data.id, sale(), intruder());
      expect(res.status).toBe(404);
    });
  });

  describe("permissions", () => {
    it("forbids a lots:view-only role from creating a lot", async () => {
      const a = await mkBatch("PERM-A", 50);
      const b = await mkBatch("PERM-B", 50);

      const res = await createLot([a.id, b.id], auditor());
      expect(res.status).toBe(403);
    });

    it("lets a lots:view-only role read lots but not sell them", async () => {
      const a = await mkBatch("PERM-SELL-A", 100);
      const b = await mkBatch("PERM-SELL-B", 100);
      const lot = await createLot([a.id, b.id]);
      createdGroupIds.push(lot.body.data.id);

      const list = await request(app).get(`${API}/batch-groups`).set(...authHeader(auditor()));
      expect(list.status).toBe(200);

      const res = await sellLot(lot.body.data.id, sale(), auditor());
      expect(res.status).toBe(403);
    });
  });
});
