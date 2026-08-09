import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { authorize } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { prisma } from "@/repositories/prisma.client";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { ADMIN_ROLES, ROLES, STAFF_ROLES } from "@/constants/roles";

const router = Router();
router.use(...protect);

const createSchema = z.object({
  body: z.object({
    companyName: z.string().min(1).max(150),
    country: z.string().max(100).optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().max(20).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

router.post(
  "/",
  authorize(...STAFF_ROLES),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const buyer = await prisma.buyer.create({ data: { ...req.body, userId: req.user!.id } });
    await recordAuditLog({ req, action: "CREATE", entityType: "Buyer", entityId: buyer.id });
    sendSuccess(res, buyer, 201);
  })
);

// Buyer records carry contact PII, so the directory is limited to the staff who
// actually transact with buyers (plus read-only auditors). A BUYER may still
// call this, but only ever sees their own record.
router.get(
  "/",
  authorize(...STAFF_ROLES, ROLES.AUDITOR, ROLES.BUYER),
  asyncHandler(async (req, res) => {
    const where = req.user!.role === ROLES.BUYER ? { userId: req.user!.id } : {};
    sendSuccess(res, await prisma.buyer.findMany({ where, orderBy: { companyName: "asc" } }));
  })
);

router.patch(
  "/:id/verify",
  authorize(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {
    const buyer = await prisma.buyer.update({ where: { id: req.params.id }, data: { isVerified: true } });
    await recordAuditLog({ req, action: "VERIFY", entityType: "Buyer", entityId: buyer.id });
    sendSuccess(res, buyer);
  })
);

export default router;
