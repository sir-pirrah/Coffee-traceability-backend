import { Request, Response } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import * as authService from "./auth.service";

export const registerHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await authService.register(req.body, {
    id: req.user.id,
    role: req.user.role,
    cooperativeId: req.user.cooperativeId,
  });
  await recordAuditLog({
    req,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });
  sendSuccess(res, user, 201);
});

export const loginHandler = asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await authService.login(req.body);
    await recordAuditLog({ req, action: "LOGIN", entityType: "User", entityId: result.user.id });
    sendSuccess(res, result);
  } catch (err) {
    await recordAuditLog({
      req,
      action: "LOGIN_FAILED",
      entityType: "User",
      // The identifier is what an administrator needs to tell a locked-out
      // farmer apart from an attack on their code. The password never goes
      // anywhere near this record.
      metadata: { identifier: req.body?.identifier },
    });
    throw err;
  }
});

export const refreshHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.refresh(req.body.refreshToken);
  sendSuccess(res, result);
});

export const changePasswordHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const result = await authService.changePassword(
    req.user.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  await recordAuditLog({
    req,
    action: "UPDATE",
    entityType: "User",
    entityId: req.user.id,
    metadata: { field: "password" },
  });
  sendSuccess(res, result);
});

export const logoutHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await authService.logout(req.user.id);
  await recordAuditLog({ req, action: "LOGOUT", entityType: "User", entityId: req.user.id });
  sendSuccess(res, { message: "Logged out successfully" });
});
