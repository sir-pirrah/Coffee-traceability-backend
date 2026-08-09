import { Router } from "express";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { assertOwnership } from "@/middleware/scopeHelpers";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { prisma } from "@/repositories/prisma.client";
import { verifyChain } from "@/blockchain/blockchain.service";
import { getBatchMovement } from "./report.service";
import { getCooperativeDashboard } from "./dashboard.service";

const router = Router();
router.use(...protect);

// Reports are cooperative-scoped: every batch-keyed report first confirms the
// batch belongs to the caller's cooperative, so a report ID cannot be used to
// read another cooperative's ledger or movement history.
async function assertBatchInScope(req: Parameters<typeof assertOwnership>[0], batchId: string): Promise<void> {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id: batchId, isDeleted: false },
    select: { cooperativeId: true },
  });
  if (!batch) throw ApiError.notFound("Coffee batch not found");
  assertOwnership(req, batch);
}

// Cooperative-level summary: deliveries, weight, and batch status
// breakdown — the backbone of Chapter 5's "Reports" objective.
router.get(
  "/cooperative/:cooperativeId/summary",
  requirePermission("reports:view"),
  asyncHandler(async (req, res) => {
    const { cooperativeId } = req.params;
    // A cooperative user can only summarize their own cooperative.
    assertOwnership(req, { cooperativeId });

    const [deliveryAgg, batchStatusCounts, farmerCount] = await Promise.all([
      prisma.delivery.aggregate({
        where: { cooperativeId },
        _sum: { weightKg: true },
        _count: { _all: true },
      }),
      prisma.coffeeBatch.groupBy({
        by: ["status"],
        where: { cooperativeId, isDeleted: false },
        _count: { _all: true },
      }),
      prisma.farmer.count({ where: { cooperativeId, isDeleted: false } }),
    ]);

    sendSuccess(res, {
      totalDeliveries: deliveryAgg._count._all,
      totalWeightKg: deliveryAgg._sum.weightKg ?? 0,
      activeFarmers: farmerCount,
      batchesByStatus: batchStatusCounts.map((b: (typeof batchStatusCounts)[number]) => ({ status: b.status, count: b._count._all })),
    });
  })
);

// Everything the cooperative dashboard renders, in one payload: KPI totals with
// a 30-day trend, the monthly movement series, the grade split, a merged
// activity feed, and ledger health. Same scope assertion as the summary — a
// cooperative user can only read their own cooperative.
router.get(
  "/cooperative/:cooperativeId/dashboard",
  requirePermission("reports:view"),
  asyncHandler(async (req, res) => {
    const { cooperativeId } = req.params;
    assertOwnership(req, { cooperativeId });

    const months = Number.parseInt(String(req.query.months ?? ""), 10);
    const dashboard = await getCooperativeDashboard(cooperativeId, {
      months: Number.isFinite(months) ? months : undefined,
    });
    sendSuccess(res, dashboard);
  })
);

// Full ledger for a batch, plus a live tamper-evidence check: `chainValid`
// recomputes every block hash and confirms each links to its predecessor, so
// the explorer can prove the history hasn't been altered.
router.get(
  "/batch/:batchId/history",
  requirePermission("blockchain:view"),
  asyncHandler(async (req, res) => {
    await assertBatchInScope(req, req.params.batchId);
    const [events, chain] = await Promise.all([
      prisma.blockchainTransaction.findMany({
        where: { batchId: req.params.batchId },
        orderBy: { submittedAt: "asc" },
      }),
      verifyChain(req.params.batchId),
    ]);
    sendSuccess(res, { events, chainValid: chain.valid, brokenAt: chain.brokenAt ?? null });
  })
);

// Coffee movement report: traces a batch's journey from delivery through
// processing, warehouse, and sale — the timeline required by Chapter 5.
router.get(
  "/batch/:batchId/movement",
  requirePermission("reports:view"),
  asyncHandler(async (req, res) => {
    await assertBatchInScope(req, req.params.batchId);
    const movement = await getBatchMovement(req.params.batchId);
    sendSuccess(res, movement);
  })
);

export default router;
