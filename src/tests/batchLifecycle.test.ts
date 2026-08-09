import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";

const API = env.API_PREFIX;

/**
 * End-to-end lifecycle: register a batch, walk it through the state machine,
 * confirm each step chains a blockchain event, and confirm the public QR
 * endpoint tells the story without leaking PII or financials.
 */
describeIfDb("batch lifecycle", () => {
  let app: Express;
  let cooperativeId: string;
  let otherCooperativeId: string;
  let batchId: string;
  let qrToken: string;

  const staff = () => ({ id: staffUserId, role: "COOPERATIVE_ADMIN" as const, cooperativeId });
  let staffUserId: string;

  beforeAll(asSystem(async () => {
    app = createApp();

    // Two cooperatives so the isolation assertions have something to cross.
    const coop = await prisma.cooperative.upsert({
      where: { registrationNo: "TEST-COOP-A" },
      update: {},
      create: { name: "Test Coop A", registrationNo: "TEST-COOP-A", county: "Nyeri" },
    });
    const other = await prisma.cooperative.upsert({
      where: { registrationNo: "TEST-COOP-B" },
      update: {},
      create: { name: "Test Coop B", registrationNo: "TEST-COOP-B", county: "Kiambu" },
    });
    cooperativeId = coop.id;
    otherCooperativeId = other.id;

    const user = await prisma.user.upsert({
      where: { email: "lifecycle-staff@test.local" },
      update: { cooperativeId },
      create: {
        email: "lifecycle-staff@test.local",
        passwordHash: "not-used-tokens-are-signed-directly",
        firstName: "Life",
        lastName: "Cycle",
        role: "COOPERATIVE_ADMIN",
        status: "ACTIVE",
        cooperativeId,
      },
    });
    staffUserId = user.id;

    // The permission matrix lives in the DB; make sure the role can act.
    for (const permission of ["batches:create", "batches:view", "batches:transition"]) {
      await prisma.rolePermission.upsert({
        where: { role_permission: { role: "COOPERATIVE_ADMIN", permission } },
        update: {},
        create: { role: "COOPERATIVE_ADMIN", permission },
      });
    }
  }));

  afterAll(asSystem(async () => {
    if (batchId) {
      // blockchain_transactions is protected by an immutability trigger that
      // blocks DELETE, so lifecycle rows are left in place deliberately.
      await prisma.coffeeBatch.updateMany({ where: { id: batchId }, data: { isDeleted: true } });
    }
    await prisma.$disconnect();
  }));

  it("registers a batch and returns a QR token", async () => {
    const res = await request(app)
      .post(`${API}/batches`)
      .set(...authHeader(staff()))
      .send({ cooperativeId, originRegion: "Mathira", harvestSeason: "2026-early" });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("REGISTERED");
    expect(res.body.data.qrCodeToken).toBeTruthy();

    batchId = res.body.data.id;
    qrToken = res.body.data.qrCodeToken;
  });

  // Reads the ledger directly rather than through an endpoint, so it needs the
  // system escape hatch — `blockchain_transactions` inherits its tenancy from the
  // batch it belongs to, and an empty context matches no batch.
  it("chains a BATCH_CREATED event with no predecessor", asSystem(async () => {
    const events = await prisma.blockchainTransaction.findMany({
      where: { batchId },
      orderBy: { submittedAt: "asc" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe("BATCH_CREATED");
    expect(events[0].previousHash).toBeNull();
    expect(events[0].blockHash).toBeTruthy();
  }));

  it("serves a printable QR image for the batch", async () => {
    const res = await request(app)
      .get(`${API}/batches/${batchId}/qr`)
      .set(...authHeader(staff()));

    expect(res.status).toBe(200);
    expect(res.body.data.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects an illegal transition (REGISTERED -> SOLD)", async () => {
    const res = await request(app)
      .patch(`${API}/batches/${batchId}/status`)
      .set(...authHeader(staff()))
      .send({ status: "SOLD" });

    expect(res.status).toBe(400);
  });

  it("refuses IN_PROCESSING while the batch has no processing record", async () => {
    const res = await request(app)
      .patch(`${API}/batches/${batchId}/status`)
      .set(...authHeader(staff()))
      .send({ status: "IN_PROCESSING" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no processing record/i);
  });

  it("refuses a processing run that starts before the batch was registered", async () => {
    const res = await request(app)
      .post(`${API}/processing`)
      .set(...authHeader(staff()))
      .send({ batchId, method: "WASHED", startDate: "2020-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/before batch .* was registered/i);
  });

  it("moves the batch to IN_PROCESSING once a processing run is recorded", async () => {
    const created = await request(app)
      .post(`${API}/processing`)
      .set(...authHeader(staff()))
      .send({ batchId, method: "WASHED", startDate: new Date().toISOString().slice(0, 10) });

    expect(created.status).toBe(201);

    const res = await request(app).get(`${API}/batches/${batchId}`).set(...authHeader(staff()));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("IN_PROCESSING");
  });

  it("links each new event to its predecessor's blockHash", asSystem(async () => {
    const events = await prisma.blockchainTransaction.findMany({
      where: { batchId },
      orderBy: { submittedAt: "asc" },
    });
    expect(events.length).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].previousHash).toBe(events[i - 1].blockHash);
    }
  }));

  it("verifies the batch's chain as intact", asSystem(async () => {
    const { verifyChain } = await import("@/blockchain/blockchain.service");
    const result = await verifyChain(batchId);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  }));

  describe("public QR verification", () => {
    it("resolves the token with no Authorization header", async () => {
      const res = await request(app).get(`${API}/batches/verify/${qrToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.batchCode).toBeTruthy();
      expect(res.body.data.chainValid).toBe(true);
    });

    it("omits farmer PII and sale financials from the public payload", async () => {
      const res = await request(app).get(`${API}/batches/verify/${qrToken}`);
      const body = JSON.stringify(res.body);

      // Kenya DPA data minimisation: none of these may reach an anonymous scan.
      for (const forbidden of ["nationalId", "phoneNumber", "salePricePerKg", "passwordHash", "contactEmail"]) {
        expect(body).not.toContain(forbidden);
      }
    });

    it("returns 404 for an unknown token", async () => {
      const res = await request(app).get(`${API}/batches/verify/does-not-exist-token`);
      expect(res.status).toBe(404);
    });
  });

  describe("cooperative data isolation", () => {
    const intruder = () => ({
      id: "22222222-2222-2222-2222-222222222222",
      role: "COOPERATIVE_ADMIN" as const,
      cooperativeId: otherCooperativeId,
    });

    // 404 rather than 403, and deliberately so: row-level security removes the
    // row from the query's result before the handler's ownership check ever sees
    // it, so the handler cannot distinguish "another tenant's batch" from "no
    // such batch" — and neither can the caller. A 403 here would confirm the id
    // exists, which is an existence oracle an outsider can enumerate. The
    // handler's own check still stands behind this as the second layer; it is
    // simply no longer the one that answers first.
    it("does not reveal another cooperative's batch by id", async () => {
      const res = await request(app)
        .get(`${API}/batches/${batchId}`)
        .set(...authHeader(intruder()));

      expect(res.status).toBe(404);
      // Denial is not enough — the response must carry no batch data either.
      expect(JSON.stringify(res.body)).not.toContain(batchId);
    });

    it("refuses to transition another cooperative's batch", async () => {
      const res = await request(app)
        .patch(`${API}/batches/${batchId}/status`)
        .set(...authHeader(intruder()))
        .send({ status: "PROCESSED" });

      expect(res.status).toBe(404);
    });

    it("leaves the batch untouched after the intruder's attempts", asSystem(async () => {
      // The transition above must have been rejected before it reached the row,
      // not merely reported as failed.
      const batch = await prisma.coffeeBatch.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch.status).toBe("IN_PROCESSING");
    }));

    it("ignores a forged ?cooperativeId and never returns another coop's batches", async () => {
      const res = await request(app)
        .get(`${API}/batches`)
        .query({ cooperativeId, page: 1, limit: 50 })
        .set(...authHeader(intruder()));

      expect(res.status).toBe(200);
      const ids = (res.body.data as { id: string }[]).map((b) => b.id);
      expect(ids).not.toContain(batchId);
    });

    it("forbids creating a batch under another cooperative", async () => {
      const res = await request(app)
        .post(`${API}/batches`)
        .set(...authHeader(intruder()))
        .send({ cooperativeId, originRegion: "Elsewhere" });
      expect(res.status).toBe(403);
    });
  });
});
