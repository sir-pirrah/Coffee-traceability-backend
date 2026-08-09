import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { assertOwnership, scopeCooperativeId } from "@/middleware/scopeHelpers";
import * as service from "./cooperative.service";

export const createHandler = asyncHandler(async (req: Request, res: Response) => {
  const coop = await service.createCooperative(req.body);
  await recordAuditLog({ req, action: "CREATE", entityType: "Cooperative", entityId: coop.id });
  sendSuccess(res, coop, 201);
});

export const listHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, county, search } = req.query as unknown as {
    page: number; limit: number; county?: string; search?: string;
  };
  // Only SUPER_ADMIN browses the full directory; everyone else sees just their
  // own cooperative, so this list can't be used to enumerate other societies.
  const scopedId = req.user!.role === "SUPER_ADMIN" ? undefined : scopeCooperativeId(req);
  const { items, total } = await service.listCooperatives({ page, limit, county, search, id: scopedId });
  sendSuccess(res, items, 200, { page, limit, total });
});

export const getByIdHandler = asyncHandler(async (req: Request, res: Response) => {
  assertOwnership(req, { cooperativeId: req.params.id });
  const coop = await service.getCooperativeById(req.params.id);
  sendSuccess(res, coop);
});

export const updateHandler = asyncHandler(async (req: Request, res: Response) => {
  // COOPERATIVE_ADMIN may edit their own cooperative's profile, not another's.
  assertOwnership(req, { cooperativeId: req.params.id });
  const coop = await service.updateCooperative(req.params.id, req.body);
  await recordAuditLog({ req, action: "UPDATE", entityType: "Cooperative", entityId: coop.id });
  sendSuccess(res, coop);
});

export const deactivateHandler = asyncHandler(async (req: Request, res: Response) => {
  const coop = await service.deactivateCooperative(req.params.id);
  await recordAuditLog({ req, action: "DELETE", entityType: "Cooperative", entityId: coop.id });
  sendSuccess(res, coop);
});
