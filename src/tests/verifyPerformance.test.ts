import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { describeIfDb, prisma, asSystem } from "./helpers/db";

const API = env.API_PREFIX;

/**
 * The proposal targets sub-3-second responses. The public QR verification
 * endpoint is the one a buyer hits from a phone on mobile data, and it is the
 * heaviest read in the system — it joins deliveries, processing, warehouse
 * movements, transfers, and the full blockchain chain, then verifies that
 * chain. If anything is going to breach the budget, it is this.
 *
 * The threshold is deliberately generous: this asserts the absence of a
 * pathological regression (an N+1 across the traceability graph, a missing
 * index), not a precise performance figure, which a CI runner cannot give.
 */
const BUDGET_MS = 3_000;

describeIfDb("public verify performance", () => {
  let app: Express;
  let token: string;
  let batchId: string;

  beforeAll(asSystem(async () => {
    app = createApp();

    const coop = await prisma.cooperative.upsert({
      where: { registrationNo: "TEST-COOP-PERF" },
      update: {},
      create: { name: "Test Coop Perf", registrationNo: "TEST-COOP-PERF", county: "Nyeri" },
    });

    token = `perf-token-${Date.now()}`;
    const batch = await prisma.coffeeBatch.create({
      data: {
        batchCode: `TEST-PERF-${Date.now()}`,
        cooperativeId: coop.id,
        qrCodeToken: token,
        originRegion: "Mathira",
        harvestSeason: "2026-early",
      },
    });
    batchId = batch.id;

    const { recordBlockchainEvent } = await import("@/blockchain/blockchain.service");
    // A realistic chain length for a batch that has completed its journey.
    await recordBlockchainEvent(batchId, "BATCH_CREATED", { seeded: true });
    await recordBlockchainEvent(batchId, "QUALITY_GRADED", { grade: "AA" });
    await recordBlockchainEvent(batchId, "PROCESSING_COMPLETED", { method: "WASHED" });
    await recordBlockchainEvent(batchId, "WAREHOUSE_STORED", { warehouse: "Main" });
    await recordBlockchainEvent(batchId, "OWNERSHIP_TRANSFERRED", { to: "buyer" });
  }));

  afterAll(asSystem(async () => {
    await prisma.coffeeBatch.updateMany({ where: { id: batchId }, data: { isDeleted: true } });
    await prisma.$disconnect();
  }));

  it(`answers a cold QR scan within ${BUDGET_MS}ms`, async () => {
    const started = performance.now();
    const res = await request(app).get(`${API}/batches/verify/${token}`);
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("stays within budget across repeated scans", async () => {
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const res = await request(app).get(`${API}/batches/verify/${token}`);
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    const worst = Math.max(...timings);
    expect(worst).toBeLessThan(BUDGET_MS);
  });
});
