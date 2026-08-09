import { Router } from "express";
import { z } from "zod";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import { notificationService } from "./notification.service";

const router = Router();
router.use(...protect);

const listSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    status: z.enum(["PENDING", "READ"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  params: z.object({}).optional(),
});

const idSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

const createSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(150),
    message: z.string().min(1).max(1000),
    channel: z.enum(["IN_APP", "EMAIL", "SMS"]).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Every route below is scoped to req.user.id — a notification is only ever
// readable, mutable, or deletable by the user it was addressed to. There is no
// endpoint that accepts a userId for reads, by design.

// List the caller's notifications, most recent first.
router.get(
  "/",
  validate(listSchema),
  asyncHandler(async (req, res) => {
    const { status, limit } = req.query as unknown as { status?: "PENDING" | "READ"; limit: number };
    const notifications = await notificationService.listForUser(req.user!.id, { status, limit });
    sendSuccess(res, notifications);
  })
);

// Unread count — the bell badge polls this, so it stays deliberately cheap.
router.get(
  "/unread/count",
  asyncHandler(async (req, res) => {
    const count = await notificationService.countUnread(req.user!.id);
    sendSuccess(res, { count });
  })
);

// Mark all unread as read. Declared before "/:id/read" for clarity; the paths
// differ in segment count so Express would not confuse them either way.
router.patch(
  "/read-all",
  asyncHandler(async (req, res) => {
    const count = await notificationService.markAllAsRead(req.user!.id);
    sendSuccess(res, { count });
  })
);

// Mark a single notification as read. Owner-scoped: another user's id yields
// 404 rather than 403, so the endpoint doesn't confirm the row exists.
router.patch(
  "/:id/read",
  validate(idSchema),
  asyncHandler(async (req, res) => {
    const ok = await notificationService.markAsRead(req.params.id, req.user!.id);
    if (!ok) throw ApiError.notFound("Notification not found");
    sendSuccess(res, { id: req.params.id, status: "READ" });
  })
);

// Delete a notification. Owner-scoped.
router.delete(
  "/:id",
  validate(idSchema),
  asyncHandler(async (req, res) => {
    const ok = await notificationService.delete(req.params.id, req.user!.id);
    if (!ok) throw ApiError.notFound("Notification not found");
    sendSuccess(res, { id: req.params.id });
  })
);

// Admin-only: send a notification to a specific user (announcements, direct
// messages from an administrator). Audited, since it writes to another user's
// inbox on their behalf.
router.post(
  "/",
  requirePermission("users:manage"),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const notification = await notificationService.create(req.body);
    await recordAuditLog({ req, action: "CREATE", entityType: "Notification", entityId: notification.id });
    sendSuccess(res, notification, 201);
  })
);

export default router;
