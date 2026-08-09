import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { authorize, requirePermission } from "@/middleware/authorize";
import { assertOwnership } from "@/middleware/scopeHelpers";
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
import { STAFF_ROLES } from "@/constants/roles";

const router = Router();
router.use(...protect);

const createSchema = z.object({
  body: z.object({
    batchId: z.string().uuid(),
    fromEntityType: z.enum(["COOPERATIVE", "WAREHOUSE", "BUYER"]),
    fromEntityId: z.string().uuid(),
    buyerId: z.string().uuid(),
    salePricePerKg: z.coerce.number().positive().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Initiates an ownership transfer (e.g. cooperative -> buyer sale).
// Status starts PENDING; a separate confirm step finalizes it and only
// then does the batch flip to SOLD and the event get chained.
router.post(
  "/",
  authorize(...STAFF_ROLES),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    // Only the cooperative that owns the batch may sell or transfer it.
    const batch = await prisma.coffeeBatch.findFirst({
      where: { id: req.body.batchId, isDeleted: false },
      select: { cooperativeId: true, batchCode: true },
    });
    if (!batch) throw ApiError.notFound("Coffee batch not found");
    assertOwnership(req, batch);

    const transfer = await prisma.ownershipTransfer.create({
      data: { ...req.body, initiatedById: req.user!.id },
    });

    // A pending transfer needs a cooperative admin to act on it, so surface it
    // to them rather than leaving it to be noticed on a list screen.
    const buyer = await prisma.buyer.findUnique({
      where: { id: req.body.buyerId },
      select: { companyName: true },
    });
    await notificationService.notifyTransferInitiated({
      cooperativeId: batch.cooperativeId,
      batchCode: batch.batchCode,
      buyerName: buyer?.companyName ?? "a buyer",
      actorId: req.user!.id,
    });

    await recordAuditLog({ req, action: "CREATE", entityType: "OwnershipTransfer", entityId: transfer.id });
    sendSuccess(res, transfer, 201);
  })
);

router.post(
  "/:id/confirm",
  authorize(...STAFF_ROLES),
  asyncHandler(async (req, res) => {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: req.params.id },
      include: {
        batch: { select: { cooperativeId: true, batchCode: true } },
        buyer: { select: { companyName: true } },
      },
    });
    if (!transfer) throw ApiError.notFound("Transfer not found");
    // Confirming a sale is scoped to the cooperative that owns the batch.
    assertOwnership(req, transfer.batch);
    if (transfer.status !== "PENDING") throw ApiError.badRequest("Transfer already finalized");

    const updated = await withTransaction(async (tx: Prisma.TransactionClient) => {
      const confirmed = await tx.ownershipTransfer.update({
        where: { id: transfer.id },
        data: { status: "CONFIRMED" },
      });
      // Confirming a sale can only happen from IN_STORAGE or IN_TRANSIT — the
      // state machine blocks a batch being sold straight out of REGISTERED.
      await transitionBatchStatus(tx, transfer.batchId, "SOLD");
      return confirmed;
    });

    // Chain the change of custody, then — when money changed hands — a
    // distinct SALE_RECORDED event so the ledger distinguishes a transfer
    // from a sale (both are required by the proposal).
    await recordBlockchainEvent(transfer.batchId, "OWNERSHIP_TRANSFERRED", {
      transferId: transfer.id,
      buyerId: transfer.buyerId,
      fromEntityType: transfer.fromEntityType,
      transferredAt: new Date().toISOString(),
    });

    if (transfer.salePricePerKg != null) {
      await recordBlockchainEvent(transfer.batchId, "SALE_RECORDED", {
        transferId: transfer.id,
        buyerId: transfer.buyerId,
        salePricePerKg: transfer.salePricePerKg.toString(),
        recordedAt: new Date().toISOString(),
      });
    }
    await recordAuditLog({ req, action: "UPDATE", entityType: "OwnershipTransfer", entityId: updated.id });

    // A confirmed sale is the terminal event staff, the initiator, and above
    // all the contributing farmers are waiting on. The batch's SOLD transition
    // happens inside the transaction above rather than through
    // updateBatchStatus, so the sale message is emitted here.
    await notificationService.notifyTransferConfirmed({
      batchId: transfer.batchId,
      cooperativeId: transfer.batch.cooperativeId,
      batchCode: transfer.batch.batchCode,
      buyerName: transfer.buyer?.companyName ?? "a buyer",
      initiatedById: transfer.initiatedById,
      actorId: req.user!.id,
    });

    sendSuccess(res, updated);
  })
);

// This read was previously unguarded — any authenticated user, including a
// BUYER or FARMER from an unrelated cooperative, could enumerate a batch's
// sale history (buyer IDs and sale prices) by ID.
router.get(
  "/batch/:batchId",
  requirePermission("batches:view"),
  asyncHandler(async (req, res) => {
    const batch = await prisma.coffeeBatch.findFirst({
      where: { id: req.params.batchId, isDeleted: false },
      select: { cooperativeId: true },
    });
    if (!batch) throw ApiError.notFound("Coffee batch not found");
    assertOwnership(req, batch);

    const transfers = await prisma.ownershipTransfer.findMany({ where: { batchId: req.params.batchId } });
    sendSuccess(res, transfers);
  })
);

export default router;
