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

const inventoryIdParamSchema = z.object({
  params: z.object({ inventoryId: z.string().uuid() }),
  query: z.object({}).optional(),
  body: z.object({}).optional(),
});

const listInventorySchema = z.object({
  query: z
    .object({
      cooperativeId: z.string().uuid().optional(),
      warehouseId: z.string().uuid().optional(),
    })
    .optional(),
  params: z.object({}).optional(),
  body: z.object({}).optional(),
});

// Prisma hands back Decimal for every weight/capacity column; comparing those
// objects directly does not do arithmetic. Two decimal places is the storage
// precision, so rounding to it also stops `0.1 + 0.2` style noise from
// rejecting a store that fits exactly.
function kg(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100) / 100;
}

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

// The current contents of the warehouses — one row per batch still in storage.
// This is the read behind the "Current stock" list and the source of the
// "In Storage" figure the UI shows per location, so it returns only *open* rows
// (`removedAt IS NULL`): a checked-out batch has physically left and must not
// keep counting. Scoped to the caller's cooperative through the warehouse join,
// since inventory rows carry no cooperative_id of their own.
router.get(
  "/inventory",
  requirePermission("warehouse:view"),
  validate(listInventorySchema),
  asyncHandler(async (req, res) => {
    const cooperativeId = scopeCooperativeId(req, req.query.cooperativeId as string | undefined);
    const rows = await prisma.warehouseInventory.findMany({
      where: {
        removedAt: null,
        warehouse: { cooperativeId },
        ...(req.query.warehouseId ? { warehouseId: req.query.warehouseId as string } : {}),
      },
      include: {
        warehouse: { select: { id: true, name: true } },
        batch: { select: { id: true, batchCode: true, status: true } },
      },
      orderBy: { storedAt: "desc" },
    });
    sendSuccess(res, rows);
  })
);

// Record a batch entering warehouse storage — updates batch status,
// creates an inventory record, and logs an immutable blockchain event.
//
// Storage is the one action that creates the `warehouse_inventory` row the
// "In Storage" KPI and the movement report read, so the checks that keep that
// number honest all live here: a batch cannot be stored twice, cannot be stored
// at more weight than it has, and cannot overfill the warehouse.
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
      prisma.warehouse.findFirst({
        where: { id: warehouseId },
        select: { cooperativeId: true, name: true, capacityKg: true },
      }),
      prisma.coffeeBatch.findFirst({
        where: { id: batchId, isDeleted: false },
        select: { cooperativeId: true, batchCode: true, totalWeightKg: true, status: true },
      }),
    ]);
    if (!warehouse) throw ApiError.notFound("Warehouse not found");
    if (!batch) throw ApiError.notFound("Coffee batch not found");
    assertOwnership(req, warehouse);
    assertOwnership(req, batch);

    const storedWeight = kg(weightKg);

    const inventory = await withTransaction(async (tx: Prisma.TransactionClient) => {
      // Take a write lock on the warehouse row before measuring its load. The
      // capacity check below is read-then-write, so two concurrent stores could
      // otherwise both measure the same free space and both fit into it. The
      // lock serialises them per warehouse, which is the granularity the limit
      // actually applies at.
      await tx.$queryRaw`SELECT id FROM warehouses WHERE id = ${warehouseId}::uuid FOR UPDATE`;

      // A batch holding an open inventory row is already in a warehouse. The
      // partial unique index on this same predicate is the backstop; this check
      // exists to answer with a sentence rather than a constraint violation.
      const openRow = await tx.warehouseInventory.findFirst({
        where: { batchId, removedAt: null },
        select: { id: true, warehouse: { select: { name: true } } },
      });
      if (openRow) {
        throw ApiError.badRequest(
          `Batch ${batch.batchCode} is already stored at ${openRow.warehouse.name}. ` +
            "Check it out of that warehouse before storing it again."
        );
      }

      // You cannot put more coffee into a warehouse than the batch contains.
      // This used to be a free-text number, so a typo silently inflated what was
      // in storage and every total derived from it.
      const batchTotal = kg(batch.totalWeightKg);
      if (storedWeight > batchTotal) {
        throw ApiError.badRequest(
          `Cannot store ${storedWeight} kg for batch ${batch.batchCode} — the batch only holds ${batchTotal} kg.`
        );
      }

      // Null capacity means the warehouse has no declared limit.
      if (warehouse.capacityKg !== null) {
        const load = await tx.warehouseInventory.aggregate({
          where: { warehouseId, removedAt: null },
          _sum: { weightKg: true },
        });
        const capacity = kg(warehouse.capacityKg);
        const currentLoad = kg(load._sum.weightKg);
        const free = Math.round((capacity - currentLoad) * 100) / 100;
        if (storedWeight > free) {
          throw ApiError.badRequest(
            `Warehouse ${warehouse.name} has ${free} kg of space left (capacity ${capacity} kg, ` +
              `currently holding ${currentLoad} kg), which is less than the ${storedWeight} kg requested.`
          );
        }
      }

      // Enforce the lifecycle: a batch can only be stored from PROCESSED (or
      // moved back from IN_TRANSIT), never straight out of REGISTERED.
      await transitionBatchStatus(tx, batchId, "IN_STORAGE");
      return tx.warehouseInventory.create({ data: { warehouseId, batchId, weightKg: storedWeight } });
    });

    await recordBlockchainEvent(batchId, "WAREHOUSE_STORED", { warehouseId, weightKg: storedWeight });
    await notificationService.notifyWarehouseStored({
      cooperativeId: batch.cooperativeId,
      batchCode: batch.batchCode,
      warehouseName: warehouse.name,
      weightKg: storedWeight,
      actorId: req.user!.id,
    });
    await recordAuditLog({ req, action: "CREATE", entityType: "WarehouseInventory", entityId: inventory.id });
    sendSuccess(res, inventory, 201);
  })
);

// Check a batch out of a warehouse.
//
// This closes the inventory row only — it does not move the batch's status. The
// two are separate on purpose: leaving a warehouse row open is what makes coffee
// keep counting as "In Storage" after it has physically gone, but the batch may
// be leaving for transit, for sale, or for a re-store, and each of those sets the
// status through its own action (`transitionBatchStatus` also closes open rows on
// those paths). The row is the warehouse's record of custody; the status is the
// batch's place in the lifecycle.
router.post(
  "/:inventoryId/remove",
  requirePermission("warehouse:remove"),
  validate(inventoryIdParamSchema),
  asyncHandler(async (req, res) => {
    const { inventoryId } = req.params;

    // The row carries no cooperative_id of its own, so ownership arrives through
    // the batch. RLS already drops another tenant's row before this runs; the
    // assert is the second layer, and it is the one that answers 403.
    const inventory = await prisma.warehouseInventory.findUnique({
      where: { id: inventoryId },
      include: {
        warehouse: { select: { name: true } },
        batch: { select: { cooperativeId: true, batchCode: true } },
      },
    });
    if (!inventory) throw ApiError.notFound("Inventory record not found");
    assertOwnership(req, inventory.batch);

    // Check-out is idempotent at the row level but not silent: a second call is
    // a mistake worth reporting, since the coffee was already released.
    if (inventory.removedAt !== null) {
      throw ApiError.badRequest(
        `Batch ${inventory.batch.batchCode} was already checked out of ${inventory.warehouse.name} on ` +
          `${inventory.removedAt.toISOString().split("T")[0]}.`
      );
    }

    const removed = await prisma.warehouseInventory.update({
      where: { id: inventoryId },
      data: { removedAt: new Date() },
    });

    await recordAuditLog({ req, action: "UPDATE", entityType: "WarehouseInventory", entityId: removed.id });
    sendSuccess(res, removed);
  })
);

export default router;
