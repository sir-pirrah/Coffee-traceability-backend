import { Router } from "express";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { authLimiter } from "@/middleware/rateLimiter";
import {
  createFarmerAccountSchema,
  createFarmerSchema,
  listFarmerSchema,
  resetFarmerPasswordSchema,
  updateFarmerSchema,
} from "./farmer.validator";
import * as controller from "./farmer.controller";

const router = Router();
router.use(...protect);

router.post("/", requirePermission("farmers:create"), validate(createFarmerSchema), controller.createHandler);
router.get("/", requirePermission("farmers:view"), validate(listFarmerSchema), controller.listHandler);
router.get("/:id", requirePermission("farmers:view"), controller.getByIdHandler);
router.patch("/:id", requirePermission("farmers:create"), validate(updateFarmerSchema), controller.updateHandler);
router.delete("/:id", requirePermission("farmers:create"), controller.deleteHandler);

// Login provisioning. `farmers:manage-account` rather than `farmers:create`:
// registering a farmer records someone in the books, issuing a login hands out a
// working credential. `authLimiter` applies because both endpoints mint a
// password — the tighter budget bounds how fast one can be churned.
router.post(
  "/:id/account",
  authLimiter,
  requirePermission("farmers:manage-account"),
  validate(createFarmerAccountSchema),
  controller.createAccountHandler
);
router.post(
  "/:id/account/reset-password",
  authLimiter,
  requirePermission("farmers:manage-account"),
  validate(resetFarmerPasswordSchema),
  controller.resetPasswordHandler
);

export default router;
