import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import * as controller from "./user.controller";

const router = Router();
router.use(...protect);

const listSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cooperativeId: z.string().uuid().optional(),
    role: z.string().optional(),
  }),
  params: z.object({}).optional(),
});

const statusSchema = z.object({
  body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "PENDING_VERIFICATION", "DEACTIVATED"]) }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

const maintenanceAccessSchema = z.object({
  body: z.object({ allowed: z.boolean() }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

router.get("/me", controller.meHandler);
router.get("/", requirePermission("users:view"), validate(listSchema), controller.listHandler);
router.patch("/:id/status", requirePermission("users:manage"), validate(statusSchema), controller.updateStatusHandler);
router.patch(
  "/:id/maintenance-access",
  requirePermission("users:manage"),
  validate(maintenanceAccessSchema),
  controller.maintenanceAccessHandler
);

export default router;
