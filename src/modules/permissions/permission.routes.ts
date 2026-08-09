import { Router } from "express";
import { z } from "zod";
import { UserRole } from "@prisma/client";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { PERMISSIONS, isPermissionKey } from "@/constants/permissions";
import {
  getMatrixObject,
  getPermissionsForRole,
  setRolePermissions,
} from "./permission.service";

const router = Router();
router.use(...protect);

const ROLE_VALUES = Object.values(UserRole) as [UserRole, ...UserRole[]];

const updateSchema = z.object({
  body: z.object({
    permissions: z.array(z.string()).max(PERMISSIONS.length),
  }),
  query: z.object({}).optional(),
  params: z.object({ role: z.enum(ROLE_VALUES) }),
});

// Full catalog + current matrix — powers the Roles & Permissions editor.
router.get(
  "/",
  requirePermission("roles:view"),
  asyncHandler(async (_req, res) => {
    const matrix = await getMatrixObject();
    sendSuccess(res, { catalog: PERMISSIONS, matrix });
  })
);

// The caller's own effective permission keys — the frontend loads this on
// login to drive nav/route/button gating.
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const role = req.user!.role;
    const permissions =
      role === "SUPER_ADMIN" ? PERMISSIONS.map((p) => p.key) : await getPermissionsForRole(role);
    sendSuccess(res, { role, permissions });
  })
);

// Replace a role's permission set. SUPER_ADMIN is immutable (always all).
router.put(
  "/:role",
  requirePermission("roles:manage"),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const role = req.params.role as UserRole;
    if (role === "SUPER_ADMIN") {
      throw ApiError.badRequest("SUPER_ADMIN permissions cannot be modified");
    }

    const invalid = (req.body.permissions as string[]).filter((k) => !isPermissionKey(k));
    if (invalid.length) {
      throw ApiError.badRequest("Unknown permission keys", { invalid });
    }

    const saved = await setRolePermissions(role, req.body.permissions);
    await recordAuditLog({
      req,
      action: "UPDATE",
      entityType: "RolePermission",
      entityId: role,
      metadata: { permissions: saved },
    });
    sendSuccess(res, { role, permissions: saved });
  })
);

export default router;
