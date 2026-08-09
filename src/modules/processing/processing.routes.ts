import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
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
import { isBeforeDay, toDateOnly } from "@/utils/dates";

const router = Router();
router.use(...protect);

const createSchema = z.object({
  body: z.object({
    batchId: z.string().uuid(),
    method: z.enum(["WASHED", "NATURAL", "HONEY", "SEMI_WASHED"]),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().optional(),
    outputWeightKg: z.coerce.number().positive().optional(),
    qualityNotes: z.string().max(500).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Create a processing record for a batch, then move the batch into
// IN_PROCESSING and log the event to the blockchain layer.
router.post(
  "/",
  requirePermission("processing:create"),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const batch = await prisma.coffeeBatch.findFirst({ where: { id: req.body.batchId, isDeleted: false } });
    if (!batch) throw ApiError.notFound("Coffee batch not found");
    // Processing may only be recorded against the caller's own batches.
    assertOwnership(req, batch);

    // A batch cannot be processed before it existed. Compared by calendar day
    // rather than by instant, because the form submits a date with no time —
    // an instant comparison would reject a run recorded on the same day the
    // batch was registered, which is the normal case.
    if (isBeforeDay(req.body.startDate, batch.createdAt)) {
      throw ApiError.badRequest(
        `Processing cannot start before batch ${batch.batchCode} was registered on ` +
          `${toDateOnly(batch.createdAt)}. Choose a start date on or after that day.`
      );
    }

    const record = await withTransaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.processingRecord.create({
        data: { ...req.body, processedById: req.user!.id },
      });
      // Starting processing moves REGISTERED → IN_PROCESSING through the state
      // machine; a batch already further along keeps its current status.
      if (batch.status === "REGISTERED") {
        await transitionBatchStatus(tx, batch.id, "IN_PROCESSING");
      }
      return created;
    });

    await recordBlockchainEvent(req.body.batchId, "PROCESSING_COMPLETED", {
      method: req.body.method,
      startDate: req.body.startDate,
    });
    await notificationService.notifyProcessingRecorded({
      cooperativeId: batch.cooperativeId,
      batchCode: batch.batchCode,
      method: req.body.method,
      actorId: req.user!.id,
    });
    await recordAuditLog({ req, action: "CREATE", entityType: "ProcessingRecord", entityId: record.id });
    sendSuccess(res, record, 201);
  })
);

router.get(
  "/batch/:batchId",
  requirePermission("processing:view"),
  asyncHandler(async (req, res) => {
    // ProcessingRecord carries no cooperativeId — scope it via its batch.
    const owning = await prisma.coffeeBatch.findFirst({
      where: { id: req.params.batchId, isDeleted: false },
      select: { cooperativeId: true },
    });
    if (!owning) throw ApiError.notFound("Coffee batch not found");
    assertOwnership(req, owning);

    const records = await prisma.processingRecord.findMany({
      where: { batchId: req.params.batchId },
      orderBy: { startDate: "desc" },
    });
    sendSuccess(res, records);
  })
);

export default router;
