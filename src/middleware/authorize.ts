import { NextFunction, Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { Role } from "@/constants/roles";
import { roleHasPermission } from "@/modules/permissions/permission.service";

// Role-based access control. Usage: router.post("/", authenticate, authorize("SUPER_ADMIN", "COOPERATIVE_ADMIN"), handler)
export function authorize(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw ApiError.unauthorized();
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw ApiError.forbidden("You do not have permission to perform this action");
    }
    next();
  };
}

// Permission-based access control (DB-backed, editable matrix). Passes when the
// caller's role holds ANY of the listed permissions. Async because it reads the
// (cached) permission matrix — errors are forwarded to next(), never thrown
// synchronously, so Express's error handler catches them.
export function requirePermission(...perms: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) throw ApiError.unauthorized();
      const results = await Promise.all(perms.map((p) => roleHasPermission(req.user!.role, p)));
      if (!results.some(Boolean)) {
        throw ApiError.forbidden("You do not have permission to perform this action");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Ensures a cooperative-scoped user can only touch data belonging to
// their own cooperative, unless they are a SUPER_ADMIN.
export function enforceCooperativeScope(cooperativeIdParam = "cooperativeId") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.role === "SUPER_ADMIN") return next();

    const targetId = req.params[cooperativeIdParam] ?? req.body?.cooperativeId;
    if (targetId && targetId !== req.user.cooperativeId) {
      throw ApiError.forbidden("You cannot access another cooperative's data");
    }
    next();
  };
}
