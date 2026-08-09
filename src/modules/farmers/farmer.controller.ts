import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { scopeCooperativeId, assertOwnership } from "@/middleware/scopeHelpers";
import { roleHasPermission } from "@/modules/permissions/permission.service";
import * as service from "./farmer.service";

export const createHandler = asyncHandler(async (req: Request, res: Response) => {
  // Farmers may only be registered within the caller's own cooperative.
  assertOwnership(req, { cooperativeId: req.body.cooperativeId });

  const { createLogin, email, ...farmerData } = req.body;

  if (!createLogin) {
    const farmer = await service.createFarmer(farmerData);
    await recordAuditLog({ req, action: "CREATE", entityType: "Farmer", entityId: farmer.id });
    sendSuccess(res, farmer, 201);
    return;
  }

  // Issuing a credential is a second, heavier permission than registering a
  // farmer — checked here rather than on the route, because the route serves both
  // cases and only this one requires it.
  if (!req.user || !(await roleHasPermission(req.user.role, "farmers:manage-account"))) {
    throw ApiError.forbidden("You are not allowed to create farmer logins");
  }

  const { farmer, credentials } = await service.createFarmerWithAccount(farmerData, { email });
  await recordAuditLog({ req, action: "CREATE", entityType: "Farmer", entityId: farmer.id });
  await recordAuditLog({
    req,
    action: "CREATE",
    entityType: "User",
    // The password is deliberately absent: an audit log is read by more people,
    // for longer, than the slip it was printed on.
    metadata: { farmerId: farmer.id, reason: "farmer login issued" },
  });
  sendSuccess(res, { ...farmer, credentials }, 201);
});

export const listHandler = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, cooperativeId, search } = req.query as unknown as {
    page: number; limit: number; cooperativeId?: string; search?: string;
  };
  // Pin non-SUPER_ADMIN users to their cooperative so a forged cooperativeId
  // or omitted filter cannot widen the list beyond their scope.
  const { items, total } = await service.listFarmers({
    page,
    limit,
    cooperativeId: scopeCooperativeId(req, cooperativeId),
    search,
  });
  sendSuccess(res, items, 200, { page, limit, total });
});

export const getByIdHandler = asyncHandler(async (req: Request, res: Response) => {
  const farmer = await service.getFarmerById(req.params.id);
  assertOwnership(req, farmer);
  sendSuccess(res, farmer);
});

export const updateHandler = asyncHandler(async (req: Request, res: Response) => {
  const existing = await service.getFarmerById(req.params.id);
  assertOwnership(req, existing);
  const farmer = await service.updateFarmer(req.params.id, req.body);
  await recordAuditLog({ req, action: "UPDATE", entityType: "Farmer", entityId: farmer.id });
  sendSuccess(res, farmer);
});

export const deleteHandler = asyncHandler(async (req: Request, res: Response) => {
  const existing = await service.getFarmerById(req.params.id);
  assertOwnership(req, existing);
  const farmer = await service.softDeleteFarmer(req.params.id);
  await recordAuditLog({ req, action: "DELETE", entityType: "Farmer", entityId: farmer.id });
  sendSuccess(res, { message: "Farmer deactivated" });
});

// ---------------------------------------------------------------------------
// Login provisioning
// ---------------------------------------------------------------------------
// Both handlers return the temporary password exactly once, in the response
// body. There is nowhere else it could go: this system has no email or SMS
// provider, so the credential is read off the screen and written down. That is
// also why neither handler puts it in the audit log.

export const createAccountHandler = asyncHandler(async (req: Request, res: Response) => {
  const farmer = await service.getFarmerById(req.params.id);
  assertOwnership(req, farmer);

  const credentials = await service.createFarmerAccount(farmer.id, { email: req.body.email });
  await recordAuditLog({
    req,
    action: "CREATE",
    entityType: "User",
    metadata: { farmerId: farmer.id, reason: "farmer login issued" },
  });
  sendSuccess(res, credentials, 201);
});

export const resetPasswordHandler = asyncHandler(async (req: Request, res: Response) => {
  const farmer = await service.getFarmerById(req.params.id);
  assertOwnership(req, farmer);

  const credentials = await service.resetFarmerPassword(farmer.id);
  await recordAuditLog({
    req,
    action: "UPDATE",
    entityType: "User",
    entityId: farmer.userId ?? undefined,
    metadata: { farmerId: farmer.id, reason: "farmer password reset" },
  });
  sendSuccess(res, credentials);
});
