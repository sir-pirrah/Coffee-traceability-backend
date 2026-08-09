import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { scopeCooperativeId, assertOwnership, farmerScopeId } from "@/middleware/scopeHelpers";
import * as service from "./coffeeBatch.service";
import { prisma } from "@/repositories/prisma.client";
import { verifyChain } from "@/blockchain/blockchain.service";
import { ApiError } from "@/utils/ApiError";

export const createHandler = asyncHandler(async (req: Request, res: Response) => {
  // A cooperative user can only create batches for their own cooperative.
  assertOwnership(req, { cooperativeId: req.body.cooperativeId });
  const batch = await service.createBatch(req.body);
  await recordAuditLog({ req, action: "CREATE", entityType: "CoffeeBatch", entityId: batch.id });
  sendSuccess(res, batch, 201);
});

export const listHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as unknown as { page: number; limit: number; cooperativeId?: string; status?: any };
  // Non-SUPER_ADMIN callers are pinned to their own cooperative, so a
  // `?cooperativeId=` pointing elsewhere (or omitted entirely) cannot widen
  // the result set beyond what they're entitled to see.
  // A farmer additionally only sees the batches their own deliveries went into,
  // not every batch the cooperative holds.
  const { items, total } = await service.listBatches({
    ...q,
    cooperativeId: scopeCooperativeId(req, q.cooperativeId),
    farmerId: (await farmerScopeId(req)) ?? undefined,
  });
  sendSuccess(res, items, 200, { page: q.page, limit: q.limit, total });
});

export const getByIdHandler = asyncHandler(async (req: Request, res: Response) => {
  // Checked before the read so an unassociated farmer can't learn a batch's
  // contents from the response, only that it exists in their cooperative.
  await assertBatchInScope(req, req.params.id);
  sendSuccess(res, await service.getBatchById(req.params.id));
});

// Returns the batch's QR code as a PNG data-URL for printing on a bag label.
export const getQrHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.id);
  sendSuccess(res, await service.getBatchQrDataUrl(req.params.id));
});

export const updateStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertBatchInScope(req, req.params.id);
  const batch = await service.updateBatchStatus(req.params.id, req.body.status, req.user!.id);
  await recordAuditLog({ req, action: "UPDATE", entityType: "CoffeeBatch", entityId: batch.id, metadata: { newStatus: req.body.status } });
  sendSuccess(res, batch);
});

/**
 * Ownership pre-check for handlers that address a single batch by id. Fetches
 * only what the check needs rather than the full traceability graph.
 *
 * Every by-id batch route funnels through here — read, QR, and status change —
 * so the cooperative rule and the farmer-association rule are stated once
 * instead of in each handler.
 */
async function assertBatchInScope(req: Request, batchId: string): Promise<void> {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id: batchId, isDeleted: false },
    select: { cooperativeId: true },
  });
  if (!batch) throw ApiError.notFound("Coffee batch not found");
  assertOwnership(req, batch);

  const ownFarmerId = await farmerScopeId(req);
  if (ownFarmerId) {
    const associated = await prisma.coffeeBatch.findFirst({
      where: { id: batchId, ...service.batchesForFarmer(ownFarmerId) },
      select: { id: true },
    });
    if (!associated) {
      throw ApiError.forbidden("You can only view batches your own deliveries went into");
    }
  }
}

// PUBLIC endpoint — no authentication required, this is what the QR code links to.
export const verifyByQrHandler = asyncHandler(async (req: Request, res: Response) => {
  const token = req.params.token;
  const batch = await service.getPublicBatchTraceability(token);

  const batchRecord = await prisma.coffeeBatch.findFirst({ where: { qrCodeToken: token } });
  if (!batchRecord) throw ApiError.notFound("Invalid QR code");

  await prisma.qrVerification.create({
    data: {
      batchId: batchRecord.id,
      verifiedIp: req.ip,
      userAgent: req.headers["user-agent"],
    },
  });

  // Aggregate deliveries into a privacy-preserving "origin" summary so the
  // public response never exposes how much each individual farmer supplied.
  const { deliveries, ...rest } = batch;
  const regions = Array.from(
    new Set(deliveries.map((d) => d.farmer?.farmLocation).filter((c): c is string => !!c))
  );
  const contributors = Array.from(
    new Set(deliveries.map((d) => d.farmer?.firstName).filter((n): n is string => !!n))
  );
  const origin = {
    farmerCount: contributors.length,
    contributorFirstNames: contributors,
    regions,
    firstDeliveredAt: deliveries[0]?.deliveryDate ?? null,
    lastDeliveredAt: deliveries.length ? deliveries[deliveries.length - 1].deliveryDate : null,
  };

  // Prove to the buyer that this batch's ledger hasn't been tampered with.
  const chain = await verifyChain(batchRecord.id);

  sendSuccess(res, { ...rest, origin, chainValid: chain.valid });
});
