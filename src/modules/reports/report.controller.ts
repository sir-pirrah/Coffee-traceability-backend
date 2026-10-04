import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { assertOwnership, farmerScopeId } from "@/middleware/scopeHelpers";
import { prisma } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import { verifyChain } from "@/blockchain/blockchain.service";
import { getBatchMovement, getBatchTraceabilitySheet } from "./report.service";
import { getCooperativeDashboard } from "./dashboard.service";
import { getOperationsSummary } from "./operations.service";
import { getFarmerStatement } from "./farmerStatement.service";
import { getProcessingYield } from "./yield.service";
import { getWarehouseInventorySnapshot } from "./inventory.service";
import { getSalesLedger } from "./sales.service";
import { buildTraceabilitySheetPdf } from "./report.pdf";

// Reports are cooperative-scoped: every batch-keyed report first confirms the
// batch belongs to the caller's cooperative, so a report ID cannot be used to
// read another cooperative's ledger or movement history.
async function assertBatchInScope(req: Request, batchId: string): Promise<void> {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id: batchId, isDeleted: false },
    select: { cooperativeId: true },
  });
  if (!batch) throw ApiError.notFound("Coffee batch not found");
  assertOwnership(req, batch);
}

type DateRangeQuery = { from?: Date; to?: Date };

// Report #1 — Operations Summary (Admin/Staff).
export const summaryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const { from, to } = req.query as unknown as DateRangeQuery;
  const summary = await getOperationsSummary(cooperativeId, { from, to });
  sendSuccess(res, summary);
});

// Cooperative dashboard payload (unchanged).
export const dashboardHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const months = Number.parseInt(String(req.query.months ?? ""), 10);
  const dashboard = await getCooperativeDashboard(cooperativeId, {
    months: Number.isFinite(months) ? months : undefined,
  });
  sendSuccess(res, dashboard);
});

// Report #2 — Farmer Delivery Statement (Admin/Staff see all or one; a FARMER is
// force-narrowed to their own id regardless of any ?farmerId= they pass).
export const farmerStatementHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const { from, to, farmerId } = req.query as unknown as DateRangeQuery & { farmerId?: string };

  const ownFarmerId = await farmerScopeId(req);
  const effectiveFarmerId = ownFarmerId ?? farmerId;

  const statement = await getFarmerStatement(cooperativeId, { from, to, farmerId: effectiveFarmerId });
  sendSuccess(res, statement);
});

// Report #3 — Batch Traceability Sheet, JSON (Admin/Staff/Auditor).
export const traceabilityHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.batchId);
  const sheet = await getBatchTraceabilitySheet(req.params.batchId);
  sendSuccess(res, sheet);
});

// Report #3 — Batch Traceability Sheet, PDF export (server-side stream).
export const traceabilityPdfHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.batchId);
  const sheet = await getBatchTraceabilitySheet(req.params.batchId);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="traceability-${sheet.batchCode}.pdf"`);
  buildTraceabilitySheetPdf(sheet, res);
});

// Report #4 — Processing Yield (Staff/Admin).
export const processingYieldHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const { from, to } = req.query as unknown as DateRangeQuery;
  const report = await getProcessingYield(cooperativeId, { from, to });
  sendSuccess(res, report);
});

// Report #5 — Warehouse Inventory Snapshot (Staff/Admin).
export const warehouseInventoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const snapshot = await getWarehouseInventorySnapshot(cooperativeId);
  sendSuccess(res, snapshot);
});

// Report #6 — Sales & Transfer Ledger (Admin only, gated by reports:financial).
export const salesLedgerHandler = asyncHandler(async (req: Request, res: Response) => {
  const { cooperativeId } = req.params;
  assertOwnership(req, { cooperativeId });
  const { from, to } = req.query as unknown as DateRangeQuery;
  const ledger = await getSalesLedger(cooperativeId, { from, to });
  sendSuccess(res, ledger);
});

// Full ledger for a batch + live tamper-evidence check.
export const historyHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.batchId);
  const [events, chain] = await Promise.all([
    prisma.blockchainTransaction.findMany({
      where: { batchId: req.params.batchId },
      orderBy: { submittedAt: "asc" },
    }),
    verifyChain(req.params.batchId),
  ]);
  sendSuccess(res, { events, chainValid: chain.valid, brokenAt: chain.brokenAt ?? null });
});

// Coffee movement report: batch journey timeline.
export const movementHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.batchId);
  const movement = await getBatchMovement(req.params.batchId);
  sendSuccess(res, movement);
});
