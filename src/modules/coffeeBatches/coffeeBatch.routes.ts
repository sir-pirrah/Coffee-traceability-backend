import { Router } from "express";
import { protect } from "@/middleware/protect";
import { systemContext } from "@/middleware/dbContext";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { createBatchSchema, listBatchSchema, updateStatusSchema } from "./coffeeBatch.validator";
import * as controller from "./coffeeBatch.controller";

const router = Router();

// Public QR verification — mounted before `protect` so buyers/consumers
// can verify a batch without an account (and regardless of maintenance mode).
// It runs in system context for the same reason: there is no caller identity for
// the row-level policies to match, and the payload is already minimised to
// non-PII by getPublicBatchTraceability. Access is gated by holding the
// unguessable QR token, not by a session.
router.get("/verify/:token", systemContext, controller.verifyByQrHandler);

router.use(...protect);

router.post("/", requirePermission("batches:create"), validate(createBatchSchema), controller.createHandler);
router.get("/", requirePermission("batches:view"), validate(listBatchSchema), controller.listHandler);
router.get("/:id", requirePermission("batches:view"), controller.getByIdHandler);
router.get("/:id/qr", requirePermission("batches:view"), controller.getQrHandler);
router.patch("/:id/status", requirePermission("batches:transition"), validate(updateStatusSchema), controller.updateStatusHandler);

export default router;
