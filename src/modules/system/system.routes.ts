import { Router } from "express";
import { z } from "zod";
import { authenticate } from "@/middleware/authenticate";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { notificationService } from "@/modules/notifications/notification.service";
import { getStatus, setMaintenance } from "./system.service";

const router = Router();

// Public — used by the login page + shell banner. Only exposes the switch and
// message, never the allowlist.
router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await getStatus());
  })
);

const maintenanceSchema = z.object({
  body: z.object({
    maintenanceMode: z.boolean(),
    message: z.string().max(500).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Toggle maintenance mode. Guarded by `system:maintenance` (SUPER_ADMIN by
// default). Not behind `maintenanceGate` so an admin can always turn it off.
router.patch(
  "/maintenance",
  authenticate,
  requirePermission("system:maintenance"),
  validate(maintenanceSchema),
  asyncHandler(async (req, res) => {
    const status = await setMaintenance(
      { maintenanceMode: req.body.maintenanceMode, maintenanceMessage: req.body.message ?? null },
      req.user!.id
    );
    await recordAuditLog({
      req,
      action: "MAINTENANCE_TOGGLE",
      entityType: "SystemSetting",
      entityId: "singleton",
      metadata: { maintenanceMode: status.maintenanceMode },
    });

    // The one case where a notification legitimately goes to every active user:
    // maintenance affects whether they can work at all.
    await notificationService.notifySystemEvent(
      status.maintenanceMode ? "System entering maintenance" : "System back online",
      status.maintenanceMode
        ? status.maintenanceMessage ?? "The system is temporarily unavailable while maintenance is carried out."
        : "Maintenance is complete and the system is fully available again.",
      req.user!.id
    );

    sendSuccess(res, status);
  })
);

export default router;
