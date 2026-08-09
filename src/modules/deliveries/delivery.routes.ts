import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { createDeliverySchema, listDeliverySchema } from "./delivery.validator";
import * as controller from "./delivery.controller";

const router = Router();
router.use(...protect);

const assignSchema = z.object({
  body: z.object({ deliveryIds: z.array(z.string().uuid()).min(1) }),
  query: z.object({}).optional(),
  params: z.object({ batchId: z.string().uuid() }),
});

router.post("/", requirePermission("deliveries:create"), validate(createDeliverySchema), controller.createHandler);
router.get("/", requirePermission("deliveries:view"), validate(listDeliverySchema), controller.listHandler);
router.get("/:id", requirePermission("deliveries:view"), controller.getByIdHandler);
router.post(
  "/batch/:batchId/assign",
  requirePermission("deliveries:create"),
  validate(assignSchema),
  controller.assignToBatchHandler
);

export default router;
