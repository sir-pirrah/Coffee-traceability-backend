import { Router } from "express";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { dateRangeQuerySchema, farmerStatementQuerySchema, summaryQuerySchema } from "./report.validator";
import * as controller from "./report.controller";

const router = Router();
router.use(...protect);

// Report #1 — Operations Summary: cooperative health check (Admin/Staff).
router.get(
  "/cooperative/:cooperativeId/summary",
  requirePermission("reports:view"),
  validate(summaryQuerySchema),
  controller.summaryHandler
);

// Cooperative dashboard payload (KPIs, trends, activity feed).
router.get(
  "/cooperative/:cooperativeId/dashboard",
  requirePermission("reports:view"),
  controller.dashboardHandler
);

// Report #2 — Farmer Delivery Statement (Admin/Staff see all; a farmer sees only
// their own rows). Farmers hold `deliveries:view`, not `reports:view`, so either
// permission is accepted and the controller narrows a farmer server-side.
router.get(
  "/cooperative/:cooperativeId/farmer-statement",
  requirePermission("reports:view", "deliveries:view"),
  validate(farmerStatementQuerySchema),
  controller.farmerStatementHandler
);

// Report #4 — Processing Yield (Staff/Admin).
router.get(
  "/cooperative/:cooperativeId/processing-yield",
  requirePermission("reports:view"),
  validate(dateRangeQuerySchema),
  controller.processingYieldHandler
);

// Report #5 — Warehouse Inventory Snapshot (Staff/Admin).
router.get(
  "/cooperative/:cooperativeId/warehouse-inventory",
  requirePermission("reports:view"),
  controller.warehouseInventoryHandler
);

// Report #6 — Sales & Transfer Ledger: Admin only, gated by the granular
// `reports:financial` key (deliberately NOT a `:view` key, so AUDITOR's
// auto-grant of every `:view` permission does not reach it).
router.get(
  "/cooperative/:cooperativeId/sales-ledger",
  requirePermission("reports:financial"),
  validate(dateRangeQuerySchema),
  controller.salesLedgerHandler
);

// Report #3 — Batch Traceability Sheet (Admin/Staff/Auditor). JSON + PDF export.
router.get("/batch/:batchId/traceability", requirePermission("reports:view"), controller.traceabilityHandler);
router.get("/batch/:batchId/traceability.pdf", requirePermission("reports:view"), controller.traceabilityPdfHandler);

// Full ledger for a batch, plus a live tamper-evidence check.
router.get("/batch/:batchId/history", requirePermission("blockchain:view"), controller.historyHandler);

// Coffee movement report: batch journey timeline.
router.get("/batch/:batchId/movement", requirePermission("reports:view"), controller.movementHandler);

export default router;
