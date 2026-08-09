import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { invalidateUserAccess } from "@/modules/system/system.service";
import { notificationService } from "@/modules/notifications/notification.service";
import { scopeCooperativeId } from "@/middleware/scopeHelpers";
import { prisma } from "@/repositories/prisma.client";
import * as service from "./user.service";

/**
 * User accounts are cooperative-scoped for everyone but SUPER_ADMIN. Unlike the
 * other entities, `User.cooperativeId` is nullable — a SUPER_ADMIN's is null —
 * so this compares strictly rather than delegating to `assertOwnership`: a null
 * on either side is a mismatch. Without that, a COOPERATIVE_ADMIN could suspend
 * a SUPER_ADMIN or revoke their maintenance access.
 */
async function assertUserInScope(req: Request, userId: string): Promise<void> {
  if (req.user!.role === "SUPER_ADMIN") return;
  const target = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: { cooperativeId: true },
  });
  if (!target) throw ApiError.notFound("User not found");
  if (!target.cooperativeId || target.cooperativeId !== req.user!.cooperativeId) {
    throw ApiError.forbidden("You cannot manage users from another cooperative");
  }
}

export const meHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  sendSuccess(res, await service.getMe(req.user.id));
});

export const listHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as unknown as { page: number; limit: number; cooperativeId?: string; role?: any };
  // Pin non-SUPER_ADMIN callers to their own cooperative — a COOPERATIVE_ADMIN
  // passing ?cooperativeId=<another> still only sees their own users.
  const scopedCoopId = req.user!.role === "SUPER_ADMIN" ? q.cooperativeId : scopeCooperativeId(req);
  const { items, total } = await service.listUsers({ ...q, cooperativeId: scopedCoopId });
  sendSuccess(res, items, 200, { page: q.page, limit: q.limit, total });
});

export const updateStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  await assertUserInScope(req, req.params.id);
  const user = await service.updateUserStatus(req.params.id, req.body.status);
  // Being suspended or reactivated is something the account holder must be
  // told about; it changes what they can do the next time they sign in.
  await notificationService.notifyUserStatusChange(user.id, req.body.status, req.user!.id);
  await recordAuditLog({ req, action: "UPDATE", entityType: "User", entityId: user.id, metadata: { newStatus: req.body.status } });
  sendSuccess(res, user);
});

export const maintenanceAccessHandler = asyncHandler(async (req: Request, res: Response) => {
  const { allowed } = req.body as { allowed: boolean };
  await assertUserInScope(req, req.params.id);
  const user = await service.setMaintenanceAccess(req.params.id, allowed);
  // Drop the per-user maintenance cache so the change takes effect immediately.
  invalidateUserAccess(user.id);
  await recordAuditLog({ req, action: "UPDATE", entityType: "User", entityId: user.id, metadata: { maintenanceAllowed: allowed } });
  sendSuccess(res, user);
});
