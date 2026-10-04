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
import { notificationService } from "@/modules/notifications/notification.service";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { STAFF_ROLES } from "@/constants/roles";
import { confirmTransferInTx, recordTransferConfirmedEvents } from "./ownershipTransfer.service";

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

    // The DB half (confirm + flip to SOLD + auto-close storage) runs in one
    // transaction; the ledger events run after it commits. Both halves are the
    // shared helper the batch-group confirm-sale also calls, so a lot sale and a
    // single sale finalize through identical logic.
    const result = await withTransaction((tx) => confirmTransferInTx(tx, transfer.id));
    await recordTransferConfirmedEvents(result);
    await recordAuditLog({ req, action: "UPDATE", entityType: "OwnershipTransfer", entityId: result.updated.id });

    // A confirmed sale is the terminal event staff, the initiator, and above all
    // the contributing farmers are waiting on.
    await notificationService.notifyTransferConfirmed({
      batchId: result.updated.batchId,
      cooperativeId: result.cooperativeId,
      batchCode: result.batchCode,
      buyerName: result.buyerName ?? "a buyer",
      initiatedById: result.updated.initiatedById,
      actorId: req.user!.id,
    });

    sendSuccess(res, result.updated);
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
