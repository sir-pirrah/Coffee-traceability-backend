import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { scopeCooperativeId, assertOwnership, farmerScopeId, assertFarmerOwnership } from "@/middleware/scopeHelpers";
import { prisma } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import * as service from "./delivery.service";

export const createHandler = asyncHandler(async (req: Request, res: Response) => {
  // Deliveries may only be registered against the caller's own cooperative.
  assertOwnership(req, { cooperativeId: req.body.cooperativeId });
  const delivery = await service.createDelivery({ ...req.body, actorId: req.user!.id });
  await recordAuditLog({ req, action: "CREATE", entityType: "Delivery", entityId: delivery.id });
  sendSuccess(res, delivery, 201);
});

export const listHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as unknown as {
    page: number; limit: number; farmerId?: string; cooperativeId?: string; batchId?: string; from?: Date; to?: Date;
  };
  // Pin non-SUPER_ADMIN callers to their own cooperative so neither an
  // omitted nor a forged `cooperativeId` can widen the result set.
  //
  // A farmer is narrowed one step further, to their own deliveries: the
  // cooperative filter alone would list every member's intake. Their own
  // `farmerId` overrides whatever was asked for, so `?farmerId=<someone else>`
  // returns their rows rather than the neighbour's.
  const ownFarmerId = await farmerScopeId(req);
  const { items, total } = await service.listDeliveries({
    ...q,
    farmerId: ownFarmerId ?? q.farmerId,
    cooperativeId: scopeCooperativeId(req, q.cooperativeId),
  });
  sendSuccess(res, items, 200, { page: q.page, limit: q.limit, total });
});

export const getByIdHandler = asyncHandler(async (req: Request, res: Response) => {
  const delivery = await service.getDeliveryById(req.params.id);
  assertOwnership(req, delivery);
  // Same-cooperative isn't enough for a farmer — the delivery must be theirs.
  assertFarmerOwnership(await farmerScopeId(req), delivery.farmerId);
  sendSuccess(res, delivery);
});

export const assignToBatchHandler = asyncHandler(async (req: Request, res: Response) => {
  // The batch must belong to the caller's cooperative; the service separately
  // rejects deliveries that belong to a different cooperative than the batch.
  const target = await prisma.coffeeBatch.findFirst({
    where: { id: req.params.batchId, isDeleted: false },
    select: { cooperativeId: true },
  });
  if (!target) throw ApiError.notFound("Coffee batch not found");
  assertOwnership(req, target);

  const batch = await service.assignDeliveriesToBatch(req.params.batchId, req.body.deliveryIds, req.user!.id);
  await recordAuditLog({ req, action: "UPDATE", entityType: "CoffeeBatch", entityId: batch.id });
  sendSuccess(res, batch);
});
