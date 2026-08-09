import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { scopeCooperativeId, assertOwnership } from "@/middleware/scopeHelpers";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { prisma, withTransaction } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";
import { recordBlockchainEvent } from "@/blockchain/blockchain.service";
import { transitionBatchStatus } from "@/modules/coffeeBatches/coffeeBatch.service";
import { notificationService } from "@/modules/notifications/notification.service";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";

const router = Router();
router.use(...protect);

const createWarehouseSchema = z.object({
  body: z.object({
    cooperativeId: z.string().uuid(),
    name: z.string().min(1).max(150),
    location: z.string().max(200).optional(),
    capacityKg: z.coerce.number().positive().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const storeSchema = z.object({
  body: z.object({
    warehouseId: z.string().uuid(),
    batchId: z.string().uuid(),
    weightKg: z.coerce.number().positive(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

router.post(
  "/",
  requirePermission("warehouse:create"),
  validate(createWarehouseSchema),
  asyncHandler(async (req, res) => {
    // Warehouses may only be created within the caller's own cooperative.
    assertOwnership(req, { cooperativeId: req.body.cooperativeId });
    const warehouse = await prisma.warehouse.create({ data: req.body });
    await recordAuditLog({ req, action: "CREATE", entityType: "Warehouse", entityId: warehouse.id });
    sendSuccess(res, warehouse, 201);
  })
);

router.get(
  "/",
  requirePermission("warehouse:view"),
  asyncHandler(async (req, res) => {
    // Pin non-SUPER_ADMIN users to their cooperative so a forged or omitted
    // cooperativeId cannot widen the list beyond their entitled scope.
    const warehouses = await prisma.warehouse.findMany({
      where: { cooperativeId: scopeCooperativeId(req, req.query.cooperativeId as string | undefined) },
    });
    sendSuccess(res, warehouses);
  })
);

// Record a batch entering warehouse storage — updates batch status,
// creates an inventory record, and logs an immutable blockchain event.
router.post(
  "/store",
  requirePermission("warehouse:store"),
  validate(storeSchema),
  asyncHandler(async (req, res) => {
    const { warehouseId, batchId, weightKg } = req.body;

    // The warehouse and batch must both belong to the caller's cooperative.
    // Names/codes are selected alongside so the notification can identify them
    // without a second round-trip.
    const [warehouse, batch] = await Promise.all([
      prisma.warehouse.findFirst({ where: { id: warehouseId }, select: { cooperativeId: true, name: true } }),
      prisma.coffeeBatch.findFirst({
        where: { id: batchId, isDeleted: false },
        select: { cooperativeId: true, batchCode: true },
      }),
    ]);
    if (!warehouse) throw ApiError.notFound("Warehouse not found");
    if (!batch) throw ApiError.notFound("Coffee batch not found");
    assertOwnership(req, warehouse);
    assertOwnership(req, batch);

    const inventory = await withTransaction(async (tx: Prisma.TransactionClient) => {
      // Enforce the lifecycle: a batch can only be stored from PROCESSED (or
      // moved back from IN_TRANSIT), never straight out of REGISTERED.
      await transitionBatchStatus(tx, batchId, "IN_STORAGE");
      return tx.warehouseInventory.create({ data: { warehouseId, batchId, weightKg } });
    });

    await recordBlockchainEvent(batchId, "WAREHOUSE_STORED", { warehouseId, weightKg });
    await notificationService.notifyWarehouseStored({
      cooperativeId: batch.cooperativeId,
      batchCode: batch.batchCode,
      warehouseName: warehouse.name,
      weightKg,
      actorId: req.user!.id,
    });
    await recordAuditLog({ req, action: "CREATE", entityType: "WarehouseInventory", entityId: inventory.id });
    sendSuccess(res, inventory, 201);
  })
);

export default router;
