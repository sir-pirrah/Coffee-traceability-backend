import { NextFunction, Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { getStatus, isMaintenanceAllowedForUser } from "@/modules/system/system.service";

// Blocks protected requests while the system is in maintenance mode, EXCEPT
// for SUPER_ADMIN and users explicitly granted maintenance access. Returns a
// 503 carrying the machine-readable code "MAINTENANCE" so the frontend can
// distinguish it from other errors, log the user out, and save their draft
// work. Must run AFTER `authenticate` (needs req.user).
export function maintenanceGate(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      if (!req.user) throw ApiError.unauthorized();

      const { maintenanceMode, maintenanceMessage } = await getStatus();
      if (!maintenanceMode || req.user.role === "SUPER_ADMIN") {
        return next();
      }

      const allowed = await isMaintenanceAllowedForUser(req.user.id);
      if (allowed) return next();

      throw ApiError.serviceUnavailable(
        maintenanceMessage || "The system is currently under maintenance. Please try again later."
      ).withCode("MAINTENANCE");
    } catch (err) {
      next(err);
    }
  })();
}
