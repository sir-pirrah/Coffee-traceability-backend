import { Router } from "express";
import { protect } from "@/middleware/protect";
import { authorize } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { ROLES } from "@/constants/roles";
import { createCooperativeSchema, updateCooperativeSchema, listCooperativeSchema } from "./cooperative.validator";
import * as controller from "./cooperative.controller";

const router = Router();

router.use(...protect);

router.post("/", authorize(ROLES.SUPER_ADMIN), validate(createCooperativeSchema), controller.createHandler);
router.get("/", validate(listCooperativeSchema), controller.listHandler);
router.get("/:id", controller.getByIdHandler);
router.patch(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.COOPERATIVE_ADMIN),
  validate(updateCooperativeSchema),
  controller.updateHandler
);
router.delete("/:id", authorize(ROLES.SUPER_ADMIN), controller.deactivateHandler);

export default router;
