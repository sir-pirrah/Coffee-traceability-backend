import crypto from "node:crypto";
import QRCode from "qrcode";
import { prisma, withTransaction } from "@/repositories/prisma.client";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { recordBlockchainEvent } from "@/blockchain/blockchain.service";
import { notificationService } from "@/modules/notifications/notification.service";
import { nextEntityCode } from "@/utils/entityCode";
import { Prisma, BatchStatus } from "@prisma/client";

// Legal state transitions — prevents e.g. jumping straight from
// REGISTERED to SOLD, or "reviving" a REJECTED batch.
const ALLOWED_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  REGISTERED: ["IN_PROCESSING", "REJECTED"],
  IN_PROCESSING: ["PROCESSED", "REJECTED"],
  PROCESSED: ["IN_STORAGE", "REJECTED"],
  IN_STORAGE: ["IN_TRANSIT", "SOLD", "REJECTED"],
  IN_TRANSIT: ["SOLD", "IN_STORAGE"],
  SOLD: ["EXPORTED"],
  EXPORTED: [],
  REJECTED: [],
};

export async function createBatch(data: { cooperativeId: string; originRegion?: string; harvestSeason?: string }) {
  const cooperative = await prisma.cooperative.findUnique({ where: { id: data.cooperativeId } });
  if (!cooperative) throw ApiError.badRequest("Invalid cooperativeId");

  const batchCode = await nextEntityCode("batch", "BATCH", 5);
  const qrCodeToken = crypto.randomBytes(24).toString("hex");

  const batch = await prisma.coffeeBatch.create({
    data: {
      batchCode,
      qrCodeToken,
      cooperative: { connect: { id: data.cooperativeId } },
      originRegion: data.originRegion,
      harvestSeason: data.harvestSeason,
    },
  });

  await recordBlockchainEvent(batch.id, "BATCH_CREATED", {
    batchCode: batch.batchCode,
    cooperativeId: data.cooperativeId,
    createdAt: batch.createdAt,
  });

  return batch;
}

/**
 * A farmer is associated with a batch when one of their deliveries went into it.
 * That relation is the only thing tying a farmer to a batch, so it is also the
 * definition of which batches they may read.
 */
export function batchesForFarmer(farmerId: string): Prisma.CoffeeBatchWhereInput {
  return { deliveries: { some: { farmerId } } };
}

export async function listBatches(opts: {
  page: number;
  limit: number;
  cooperativeId?: string;
  status?: BatchStatus;
  farmerId?: string;
}) {
  const where: Prisma.CoffeeBatchWhereInput = {
    isDeleted: false,
    ...(opts.cooperativeId && { cooperativeId: opts.cooperativeId }),
    ...(opts.status && { status: opts.status }),
    // Present only for farmer callers: narrows the cooperative's batches to the
    // ones their own coffee actually went into.
    ...(opts.farmerId && batchesForFarmer(opts.farmerId)),
  };

  const [items, total] = await Promise.all([
    prisma.coffeeBatch.findMany({
      where,
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.coffeeBatch.count({ where }),
  ]);

  return { items, total };
}

export async function getBatchById(id: string) {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id, isDeleted: false },
    include: {
      // A farmer caller only ever sees their own rows here: the deliveries
      // policy narrows this nested read the same way it narrows a direct one,
      // so the detail view inherits the isolation rule without restating it.
      deliveries: { include: { farmer: { select: { firstName: true, lastName: true, farmerCode: true } } } },
      processingRecords: true,
      ownershipTransfers: { include: { buyer: { select: { companyName: true, country: true } } } },
      blockchainTxs: { orderBy: { submittedAt: "desc" } },
    },
  });
  if (!batch) throw ApiError.notFound("Coffee batch not found");
  return batch;
}

// Map a target batch status to the blockchain event it represents, so the
// ledger records semantically-correct event types instead of a single label.
const STATUS_EVENT: Record<BatchStatus, "PROCESSING_COMPLETED" | "WAREHOUSE_STORED" | "SALE_RECORDED" | "OWNERSHIP_TRANSFERRED"> = {
  REGISTERED: "PROCESSING_COMPLETED",
  IN_PROCESSING: "PROCESSING_COMPLETED",
  PROCESSED: "PROCESSING_COMPLETED",
  IN_STORAGE: "WAREHOUSE_STORED",
  IN_TRANSIT: "OWNERSHIP_TRANSFERRED",
  SOLD: "SALE_RECORDED",
  EXPORTED: "SALE_RECORDED",
  REJECTED: "PROCESSING_COMPLETED",
};

/**
 * Applies a batch status change through the state machine, inside whatever
 * transaction the caller is already running.
 *
 * Warehouse storage, processing start, and ownership confirmation each used to
 * write `status` directly, which let a batch skip states entirely (e.g. be
 * stored while still REGISTERED, or sold without ever being processed). Routing
 * every write through here means the transition rules and the ledger event are
 * enforced in one place regardless of which module triggers the change.
 *
 * Returns the previous status so the caller can record it on the ledger.
 */
export async function transitionBatchStatus(
  tx: Prisma.TransactionClient,
  batchId: string,
  newStatus: BatchStatus
): Promise<BatchStatus> {
  const batch = await tx.coffeeBatch.findFirst({ where: { id: batchId, isDeleted: false } });
  if (!batch) throw ApiError.notFound("Coffee batch not found");

  if (batch.status === newStatus) return batch.status;

  const allowed = ALLOWED_TRANSITIONS[batch.status];
  if (!allowed.includes(newStatus)) {
    throw ApiError.badRequest(`Cannot transition batch from ${batch.status} to ${newStatus}`);
  }

  // Both processing states are claims about work that actually happened, so they
  // need a processing record behind them. Without this the status dropdown alone
  // could walk a batch through IN_PROCESSING and PROCESSED with nothing recorded
  // about method or dates — and the ledger would carry a PROCESSING_COMPLETED
  // event for processing that was never done.
  //
  // The processing route creates its record inside the same transaction before
  // calling this, so the legitimate path sees its own record here.
  if (newStatus === "IN_PROCESSING" || newStatus === "PROCESSED") {
    const recordCount = await tx.processingRecord.count({ where: { batchId } });
    if (recordCount === 0) {
      throw ApiError.badRequest(
        `Batch ${batch.batchCode} has no processing record, so it cannot be moved to ${newStatus}. ` +
          "Record the processing run for this batch first — that moves it into processing for you."
      );
    }
  }

  await tx.coffeeBatch.update({ where: { id: batchId }, data: { status: newStatus } });
  return batch.status;
}

export async function updateBatchStatus(id: string, newStatus: BatchStatus, actorId?: string) {
  const previousStatus = await withTransaction((tx) => transitionBatchStatus(tx, id, newStatus));

  const updated = await prisma.coffeeBatch.findUniqueOrThrow({ where: { id } });

  await recordBlockchainEvent(id, STATUS_EVENT[newStatus], {
    previousStatus,
    newStatus,
    changedAt: new Date().toISOString(),
  });

  // A no-op transition (status already at the target) shouldn't generate noise.
  if (previousStatus !== newStatus) {
    await notificationService.notifyBatchStatusChange({
      batchId: id,
      batchCode: updated.batchCode,
      cooperativeId: updated.cooperativeId,
      fromStatus: previousStatus,
      toStatus: newStatus,
      actorId,
    });
  }

  return updated;
}

// Public verification lookup — used by the QR scan endpoint. Returns the full
// traceability story of the batch, but is deliberately data-minimized (Kenya
// Data Protection Act 2019): NO national IDs, phone numbers, GPS, prices or
// other financial/PII fields ever reach the public. Only what a consumer needs
// to trust the coffee's origin and journey.
export async function getPublicBatchTraceability(qrCodeToken: string) {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { qrCodeToken, isDeleted: false },
    select: {
      batchCode: true,
      status: true,
      originRegion: true,
      harvestSeason: true,
      totalWeightKg: true,
      createdAt: true,
      cooperative: { select: { name: true, county: true } },
      // Origin: farmer first name + region only, no PII. Aggregated at the
      // controller into a summary so we don't leak how many farmers or exact
      // amounts per farmer.
      deliveries: {
        select: {
          weightKg: true,
          qualityGrade: true,
          deliveryDate: true,
          farmer: { select: { firstName: true, farmLocation: true } },
        },
        orderBy: { deliveryDate: "asc" },
      },
      processingRecords: {
        select: { method: true, startDate: true, endDate: true },
        orderBy: { startDate: "asc" },
      },
      // Warehouse steps — location + when stored, no capacities/financials.
      warehouseInventory: {
        select: {
          storedAt: true,
          removedAt: true,
          warehouse: { select: { name: true, location: true } },
        },
        orderBy: { storedAt: "asc" },
      },
      ownershipTransfers: {
        select: { status: true, transferredAt: true, buyer: { select: { companyName: true, country: true } } },
        orderBy: { transferredAt: "asc" },
      },
      blockchainTxs: {
        where: { status: "CONFIRMED" },
        select: { eventType: true, txHash: true, confirmedAt: true },
        orderBy: { confirmedAt: "asc" },
      },
    },
  });
  if (!batch) throw ApiError.notFound("No batch found for this QR code");
  return batch;
}

// Generate the batch's QR code as a PNG data-URL. The QR encodes the public
// verify URL so a phone camera scan opens the traceability page directly.
export async function getBatchQrDataUrl(id: string): Promise<{ batchCode: string; verifyUrl: string; dataUrl: string }> {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id, isDeleted: false },
    select: { batchCode: true, qrCodeToken: true },
  });
  if (!batch) throw ApiError.notFound("Coffee batch not found");

  const verifyUrl = `${env.FRONTEND_URL}/verify?token=${batch.qrCodeToken}`;
  const dataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
    color: { dark: "#0B3D20", light: "#FFFFFF" },
  });

  return { batchCode: batch.batchCode, verifyUrl, dataUrl };
}
