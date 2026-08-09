import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";
import { runWithDbContext, runAsSystem } from "@/repositories/dbContext";

const API = env.API_PREFIX;

/**
 * A farmer sees their own deliveries and the batches their coffee went into —
 * nothing else, not even from their own cooperative.
 *
 * The rule is enforced twice on purpose, and this suite asserts both layers
 * separately, because they fail in different ways:
 *
 *   - The service layer narrows queries and produces the error messages a farmer
 *     actually reads.
 *   - Postgres row-level security restates the same rule underneath, so a query
 *     that forgets its filter returns nothing rather than everything.
 *
 * Testing only the endpoints would pass even if the policies were dropped, and
 * testing only the policies would pass even if the API leaked. Hence both.
 *
 * The fixture is two farmers in ONE cooperative. Cross-cooperative isolation is
 * already covered in batchLifecycle; the interesting case here is the harder one
 * — a neighbour with an equal claim to the tenant, where cooperative scoping
 * alone would happily hand over their records.
 */
describeIfDb("farmer isolation", () => {
  let app: Express;
  let cooperativeId: string;

  // "Mine" — the farmer under test.
  let mineFarmerId: string;
  let mineUserId: string;
  let myDeliveryId: string;
  let myBatchId: string;

  // "Theirs" — a different farmer in the same cooperative.
  let theirFarmerId: string;
  let theirDeliveryId: string;
  let theirBatchId: string;

  // A batch both farmers delivered into — see the fixture note below.
  let sharedBatchId: string;
  let myShareDeliveryId: string;
  let theirShareDeliveryId: string;

  let staffUserId: string;

  const farmer = () => ({ id: mineUserId, role: "FARMER" as const, cooperativeId });
  const staff = () => ({ id: staffUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId });

  beforeAll(
    asSystem(async () => {
      app = createApp();

      const coop = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-FARMER" },
        update: {},
        create: { name: "Test Coop Farmer", registrationNo: "TEST-COOP-FARMER", county: "Nyeri" },
      });
      cooperativeId = coop.id;

      const mineUser = await prisma.user.upsert({
        where: { email: "farmer-mine@test.local" },
        update: { cooperativeId },
        create: {
          email: "farmer-mine@test.local",
          passwordHash: "not-used-tokens-are-signed-directly",
          firstName: "Mine",
          lastName: "Farmer",
          role: "FARMER",
          status: "ACTIVE",
          cooperativeId,
        },
      });
      mineUserId = mineUser.id;

      const staffUser = await prisma.user.upsert({
        where: { email: "farmer-suite-staff@test.local" },
        update: { cooperativeId },
        create: {
          email: "farmer-suite-staff@test.local",
          passwordHash: "not-used-tokens-are-signed-directly",
          firstName: "Suite",
          lastName: "Staff",
          role: "COOPERATIVE_ADMIN",
          status: "ACTIVE",
          cooperativeId,
        },
      });
      staffUserId = staffUser.id;

      // Only "mine" is linked to a user account; "theirs" is a farmer record the
      // cooperative keeps books for, which is enough to own deliveries.
      const mine = await prisma.farmer.upsert({
        where: { farmerCode: "TEST-FARMER-MINE" },
        update: { userId: mineUserId, cooperativeId, isDeleted: false },
        create: {
          farmerCode: "TEST-FARMER-MINE",
          firstName: "Mine",
          lastName: "Farmer",
          cooperativeId,
          userId: mineUserId,
        },
      });
      mineFarmerId = mine.id;

      const theirs = await prisma.farmer.upsert({
        where: { farmerCode: "TEST-FARMER-THEIRS" },
        update: { cooperativeId, isDeleted: false },
        create: {
          farmerCode: "TEST-FARMER-THEIRS",
          firstName: "Their",
          lastName: "Farmer",
          cooperativeId,
        },
      });
      theirFarmerId = theirs.id;

      // One batch per farmer, each fed by that farmer's delivery. This is what
      // makes "associated with" mean something: the batches are siblings in the
      // same cooperative and differ only in whose coffee is in them.
      const stamp = Date.now();
      const myBatch = await prisma.coffeeBatch.create({
        data: {
          batchCode: `TEST-FI-MINE-${stamp}`,
          cooperativeId,
          qrCodeToken: `test-fi-mine-${stamp}`,
          originRegion: "Mathira",
        },
      });
      myBatchId = myBatch.id;

      const theirBatch = await prisma.coffeeBatch.create({
        data: {
          batchCode: `TEST-FI-THEIRS-${stamp}`,
          cooperativeId,
          qrCodeToken: `test-fi-theirs-${stamp}`,
          originRegion: "Othaya",
        },
      });
      theirBatchId = theirBatch.id;

      const myDelivery = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FI-DEL-MINE-${stamp}`,
          farmerId: mineFarmerId,
          cooperativeId,
          weightKg: 120.5,
          qualityGrade: "AA",
          batchId: myBatchId,
        },
      });
      myDeliveryId = myDelivery.id;

      const theirDelivery = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FI-DEL-THEIRS-${stamp}`,
          farmerId: theirFarmerId,
          cooperativeId,
          weightKg: 80.25,
          qualityGrade: "AB",
          batchId: theirBatchId,
        },
      });
      theirDeliveryId = theirDelivery.id;

      // A batch fed by BOTH farmers, which is the case the batch-detail screen
      // turns on. The farmer is legitimately associated with it and must be able
      // to open it, so "hide the whole batch" is not the answer here — the
      // neighbour's delivery line inside it is what has to stay hidden.
      //
      // `totalWeightKg` is set to the true combined weight on purpose: the
      // detail page reads it as the batch total while listing only the
      // deliveries the caller may see, and that gap is the point. A farmer
      // seeing "100 kg total" beside their own 60 kg learns their share without
      // learning whose coffee the rest is.
      const sharedBatch = await prisma.coffeeBatch.create({
        data: {
          batchCode: `TEST-FI-SHARED-${stamp}`,
          cooperativeId,
          qrCodeToken: `test-fi-shared-${stamp}`,
          originRegion: "Karatina",
          totalWeightKg: 100,
        },
      });
      sharedBatchId = sharedBatch.id;

      const myShare = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FI-DEL-SHARE-MINE-${stamp}`,
          farmerId: mineFarmerId,
          cooperativeId,
          weightKg: 60,
          qualityGrade: "AA",
          batchId: sharedBatchId,
        },
      });
      myShareDeliveryId = myShare.id;

      const theirShare = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FI-DEL-SHARE-THEIRS-${stamp}`,
          farmerId: theirFarmerId,
          cooperativeId,
          weightKg: 40,
          qualityGrade: "AB",
          batchId: sharedBatchId,
        },
      });
      theirShareDeliveryId = theirShare.id;

      for (const permission of ["deliveries:view", "batches:view"]) {
        await prisma.rolePermission.upsert({
          where: { role_permission: { role: "FARMER", permission } },
          update: {},
          create: { role: "FARMER", permission },
        });
      }
      for (const permission of ["deliveries:view", "batches:view"]) {
        await prisma.rolePermission.upsert({
          where: { role_permission: { role: "COOPERATIVE_ADMIN", permission } },
          update: {},
          create: { role: "COOPERATIVE_ADMIN", permission },
        });
      }
    })
  );

  afterAll(
    asSystem(async () => {
      await prisma.delivery.deleteMany({
        where: { id: { in: [myDeliveryId, theirDeliveryId, myShareDeliveryId, theirShareDeliveryId] } },
      });
      await prisma.coffeeBatch.updateMany({
        where: { id: { in: [myBatchId, theirBatchId, sharedBatchId] } },
        data: { isDeleted: true },
      });
      await prisma.$disconnect();
    })
  );

  // ---------------------------------------------------------------------------
  // Rule 1 — a farmer may view only their own deliveries.
  // ---------------------------------------------------------------------------

  it("lists only the farmer's own deliveries", async () => {
    const res = await request(app)
      .get(`${API}/deliveries`)
      .query({ page: 1, limit: 50 })
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(myDeliveryId);
    expect(ids).not.toContain(theirDeliveryId);
  });

  it("reports a delivery count that excludes other farmers' rows", async () => {
    // Pagination totals are computed by a separate count query, which is exactly
    // the kind of second query that can miss a filter — a farmer must not learn
    // how much coffee their neighbours delivered from the row count either.
    const res = await request(app)
      .get(`${API}/deliveries`)
      .query({ page: 1, limit: 1 })
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    const rows = await runAsSystem(() => prisma.delivery.count({ where: { farmerId: mineFarmerId } }));
    expect(res.body.pagination.total).toBe(rows);
  });

  it("does not reveal another farmer's delivery by id", async () => {
    const res = await request(app)
      .get(`${API}/deliveries/${theirDeliveryId}`)
      .set(...authHeader(farmer()));

    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("TEST-FI-DEL-THEIRS");
  });

  it("still serves the farmer their own delivery by id", async () => {
    const res = await request(app)
      .get(`${API}/deliveries/${myDeliveryId}`)
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(myDeliveryId);
  });

  it("lets cooperative staff see both farmers' deliveries", async () => {
    // The narrowing must apply to farmers specifically, not to everyone: staff
    // keep the books for the whole cooperative.
    const res = await request(app)
      .get(`${API}/deliveries`)
      .query({ page: 1, limit: 50 })
      .set(...authHeader(staff()));

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(myDeliveryId);
    expect(ids).toContain(theirDeliveryId);
  });

  // ---------------------------------------------------------------------------
  // Rule 2 — a farmer may view only batches they are associated with.
  // ---------------------------------------------------------------------------

  it("lists only batches the farmer delivered into", async () => {
    const res = await request(app)
      .get(`${API}/batches`)
      .query({ page: 1, limit: 50 })
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(myBatchId);
    expect(ids).not.toContain(theirBatchId);
  });

  it("does not reveal an unassociated batch by id", async () => {
    const res = await request(app)
      .get(`${API}/batches/${theirBatchId}`)
      .set(...authHeader(farmer()));

    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("TEST-FI-THEIRS");
  });

  it("serves a batch the farmer is associated with", async () => {
    const res = await request(app)
      .get(`${API}/batches/${myBatchId}`)
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(myBatchId);
  });

  it("does not leak an unassociated batch through the QR endpoint", async () => {
    // Same rule, different door. `/qr` returns a scannable code for a batch and
    // is guarded by the same permission, so it has to honour the same scope.
    const res = await request(app)
      .get(`${API}/batches/${theirBatchId}/qr`)
      .set(...authHeader(farmer()));

    expect([403, 404]).toContain(res.status);
  });

  it("still lets cooperative staff see both batches", async () => {
    const res = await request(app)
      .get(`${API}/batches`)
      .query({ page: 1, limit: 50 })
      .set(...authHeader(staff()));

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(myBatchId);
    expect(ids).toContain(theirBatchId);
  });

  // ---------------------------------------------------------------------------
  // Rule 2, applied to the batch-detail view.
  // ---------------------------------------------------------------------------
  // A batch a farmer shares with a neighbour is the hard case: the batch itself
  // is legitimately theirs to open, so isolation has to hold *inside* the
  // payload rather than by refusing the whole request.

  it("opens a shared batch for a farmer who contributed to it", async () => {
    const res = await request(app)
      .get(`${API}/batches/${sharedBatchId}`)
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(sharedBatchId);
  });

  it("lists only the farmer's own delivery inside a shared batch", async () => {
    // The detail screen prints a farmer's name beside each delivery weight, so
    // an unscoped nested read here would put a neighbour's name and tonnage on
    // screen even though the direct deliveries endpoint refuses them.
    const res = await request(app)
      .get(`${API}/batches/${sharedBatchId}`)
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    const ids = (res.body.data.deliveries as { id: string }[]).map((d) => d.id);
    expect(ids).toEqual([myShareDeliveryId]);

    // Names and codes travel with the delivery, so assert on the payload text
    // too — not just the id list.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("TEST-FI-DEL-SHARE-THEIRS");
    expect(body).not.toContain("TEST-FARMER-THEIRS");
  });

  it("still reports the shared batch's true total weight to the farmer", async () => {
    // The counterpart to the test above: hiding the neighbour's row must not
    // also shrink the batch. `totalWeightKg` is a column on the batch, which no
    // policy narrows, so the farmer sees 100 kg total against their own 60 —
    // enough to know their share, not enough to know whose the rest is.
    const res = await request(app)
      .get(`${API}/batches/${sharedBatchId}`)
      .set(...authHeader(farmer()));

    expect(res.status).toBe(200);
    expect(Number(res.body.data.totalWeightKg)).toBe(100);
    expect(Number(res.body.data.deliveries[0].weightKg)).toBe(60);
  });

  it("shows cooperative staff every delivery in the shared batch", async () => {
    const res = await request(app)
      .get(`${API}/batches/${sharedBatchId}`)
      .set(...authHeader(staff()));

    expect(res.status).toBe(200);
    const ids = (res.body.data.deliveries as { id: string }[]).map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(myShareDeliveryId);
    expect(ids).toContain(theirShareDeliveryId);
  });

  // ---------------------------------------------------------------------------
  // The database layer, asserted on its own.
  // ---------------------------------------------------------------------------
  // These queries carry NO application-level filter — the `where` clause asks for
  // rows the farmer must not see. If the policies were dropped, every one would
  // return them. This is the part that keeps holding when a future endpoint
  // forgets to call the scope helper.

  const asFarmer = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithDbContext({ userId: mineUserId, role: "FARMER", cooperativeId, farmerId: mineFarmerId }, fn);

  it("filters another farmer's delivery out of an unfiltered query", async () => {
    const rows = await asFarmer(() => prisma.delivery.findMany({ where: { cooperativeId } }));

    expect(rows.map((d) => d.id)).toContain(myDeliveryId);
    expect(rows.map((d) => d.id)).not.toContain(theirDeliveryId);
  });

  it("returns nothing when a farmer queries another farmer's delivery directly by id", async () => {
    const row = await asFarmer(() => prisma.delivery.findUnique({ where: { id: theirDeliveryId } }));
    expect(row).toBeNull();
  });

  it("filters an unassociated batch out of an unfiltered query", async () => {
    const rows = await asFarmer(() => prisma.coffeeBatch.findMany({ where: { cooperativeId } }));

    expect(rows.map((b) => b.id)).toContain(myBatchId);
    expect(rows.map((b) => b.id)).not.toContain(theirBatchId);
  });

  it("hides another farmer's personal details from a farmer", async () => {
    // farmers rows carry national IDs and phone numbers, so this is a Kenya DPA
    // concern and not only an access-control one.
    const rows = await asFarmer(() => prisma.farmer.findMany({ where: { cooperativeId } }));

    expect(rows.map((f) => f.id)).toEqual([mineFarmerId]);
  });

  it("refuses to let a farmer write a delivery for someone else", async () => {
    // Reads are only half the rule. WITH CHECK is what stops a farmer from
    // reassigning a neighbour's delivery to themselves, or inventing one.
    await expect(
      asFarmer(() =>
        prisma.delivery.updateMany({ where: { id: theirDeliveryId }, data: { qualityGrade: "TAMPERED" } })
      )
    ).resolves.toMatchObject({ count: 0 });

    const untouched = await runAsSystem(() => prisma.delivery.findUniqueOrThrow({ where: { id: theirDeliveryId } }));
    expect(untouched.qualityGrade).toBe("AB");
  });

  it("returns no rows at all when the context is empty", async () => {
    // The fail-closed case: a request that never authenticated, or a background
    // job that forgot to establish context, sees an empty database rather than
    // the whole one.
    const rows = await runWithDbContext({}, () => prisma.delivery.findMany({ where: { cooperativeId } }));
    expect(rows).toHaveLength(0);
  });
});
