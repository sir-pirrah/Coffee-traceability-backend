import { prisma } from "@/repositories/prisma.client";
import { logger } from "@/config/logger";
import { ROLES } from "@/constants/roles";
import type { NotificationChannel, UserRole } from "@prisma/client";

export interface CreateNotificationInput {
  userId: string;
  title: string;
  message: string;
  channel?: NotificationChannel;
}

/** Roles that run cooperative operations and should hear about batch/delivery activity. */
const OPS_ROLES: UserRole[] = [ROLES.COOPERATIVE_ADMIN, ROLES.COOPERATIVE_STAFF];

/**
 * Notification service: creates in-app notifications in response to domain
 * events (deliveries registered, batches advancing, sales confirmed,
 * maintenance windows, account changes).
 *
 * Two rules govern everything here:
 *
 * 1. **Emission never breaks business logic.** A notification is a side effect
 *    of an operation that has already succeeded and committed. If the insert
 *    fails, we log it and move on — a delivery must not 500 because the
 *    notifications table was briefly unavailable. Every `notify*` helper is
 *    therefore `Promise<void>` and swallows its own errors.
 *
 * 2. **Never notify the actor about their own action.** The user who registered
 *    the delivery does not need to be told a delivery was registered; without
 *    this, an active staff member's bell fills with echoes of their own clicks.
 *    Callers pass `actorId` and it is filtered out of every recipient list.
 */
export class NotificationService {
  // ---------------------------------------------------------------------------
  // CORE CRUD — used by the routes layer, these DO throw so the API can 404/500
  // ---------------------------------------------------------------------------

  /** Create a notification for a single user. */
  async create(input: CreateNotificationInput) {
    return prisma.notification.create({
      data: {
        userId: input.userId,
        title: input.title,
        message: input.message,
        channel: input.channel ?? "IN_APP",
        status: "PENDING",
      },
    });
  }

  /** List a user's notifications, most recent first. */
  async listForUser(userId: string, opts: { status?: "PENDING" | "READ"; limit?: number } = {}) {
    return prisma.notification.findMany({
      where: { userId, ...(opts.status && { status: opts.status }) },
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 50,
    });
  }

  /** Count unread (PENDING) notifications — drives the bell badge. */
  async countUnread(userId: string) {
    return prisma.notification.count({ where: { userId, status: "PENDING" } });
  }

  /** Mark one notification as read. Owner-scoped: a mismatched userId is a no-op. */
  async markAsRead(notificationId: string, userId: string) {
    const { count } = await prisma.notification.updateMany({
      where: { id: notificationId, userId, status: "PENDING" },
      data: { status: "READ", readAt: new Date() },
    });
    if (count > 0) return true;
    // Already-read notifications should report success rather than 404 — the
    // client may retry, or two tabs may race on the same item.
    const exists = await prisma.notification.count({ where: { id: notificationId, userId } });
    return exists > 0;
  }

  /** Mark every unread notification for a user as read. Returns how many changed. */
  async markAllAsRead(userId: string) {
    const { count } = await prisma.notification.updateMany({
      where: { userId, status: "PENDING" },
      data: { status: "READ", readAt: new Date() },
    });
    return count;
  }

  /** Delete a notification. Owner-scoped. */
  async delete(notificationId: string, userId: string) {
    const { count } = await prisma.notification.deleteMany({ where: { id: notificationId, userId } });
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // INTERNAL PLUMBING
  // ---------------------------------------------------------------------------

  /**
   * Fan a notification out to many users in one insert. Returns silently when
   * the recipient list is empty so callers don't need to guard.
   */
  private async fanOut(userIds: string[], title: string, message: string, channel: NotificationChannel = "IN_APP") {
    if (userIds.length === 0) return 0;
    const { count } = await prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, title, message, channel, status: "PENDING" as const })),
    });
    return count;
  }

  /**
   * Resolve the active users in a cooperative holding any of `roles`, minus the
   * actor. SUPER_ADMINs are deliberately excluded from routine operational
   * traffic — they'd otherwise receive every event from every cooperative.
   */
  private async recipientsIn(cooperativeId: string, roles: UserRole[], actorId?: string): Promise<string[]> {
    const users = await prisma.user.findMany({
      where: {
        cooperativeId,
        status: "ACTIVE",
        isDeleted: false,
        role: { in: roles },
        ...(actorId && { id: { not: actorId } }),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Run an emission, absorbing any failure. This is the guard that keeps a
   * notification problem from surfacing as a failed business request.
   */
  private async safely(event: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, event }, "Failed to emit notification");
    }
  }

  // ---------------------------------------------------------------------------
  // DOMAIN EVENTS — called from business logic. These never throw.
  // ---------------------------------------------------------------------------

  /**
   * A farmer's delivery was registered. Cooperative staff hear about the intake;
   * the farmer hears about it too, if they have a user account linked.
   */
  async notifyDeliveryCreated(input: {
    cooperativeId: string;
    deliveryCode: string;
    farmerName: string;
    farmerUserId?: string | null;
    weightKg: number;
    actorId?: string;
  }): Promise<void> {
    await this.safely("delivery.created", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      await this.fanOut(
        staff,
        "New delivery registered",
        `${input.farmerName} delivered ${input.weightKg} kg — ${input.deliveryCode}.`
      );

      if (input.farmerUserId && input.farmerUserId !== input.actorId) {
        await this.create({
          userId: input.farmerUserId,
          title: "Delivery recorded",
          message: `Your delivery of ${input.weightKg} kg has been recorded as ${input.deliveryCode}.`,
        });
      }
    });
  }

  /** Deliveries were pooled into a batch. */
  async notifyDeliveriesAssigned(input: {
    cooperativeId: string;
    batchCode: string;
    deliveryCount: number;
    actorId?: string;
  }): Promise<void> {
    await this.safely("delivery.assigned", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      const noun = input.deliveryCount === 1 ? "delivery" : "deliveries";
      await this.fanOut(
        staff,
        "Deliveries added to batch",
        `${input.deliveryCount} ${noun} assigned to batch ${input.batchCode}.`
      );
    });
  }

  /**
   * A batch moved through the lifecycle. Staff are told for every transition;
   * when the batch is sold or exported, the farmers who contributed to it are
   * told as well — that is the outcome they actually care about.
   */
  async notifyBatchStatusChange(input: {
    batchId: string;
    batchCode: string;
    cooperativeId: string;
    fromStatus: string;
    toStatus: string;
    actorId?: string;
  }): Promise<void> {
    await this.safely("batch.status", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      await this.fanOut(
        staff,
        "Batch status updated",
        `Batch ${input.batchCode} moved from ${input.fromStatus} to ${input.toStatus}.`
      );

      if (input.toStatus === "SOLD" || input.toStatus === "EXPORTED") {
        await this.notifyContributingFarmers(
          input.batchId,
          "Your coffee has been sold",
          `Batch ${input.batchCode}, which includes your deliveries, is now ${input.toStatus.toLowerCase()}.`,
          input.actorId
        );
      }
    });
  }

  /** Processing was recorded against a batch. */
  async notifyProcessingRecorded(input: {
    cooperativeId: string;
    batchCode: string;
    method: string;
    actorId?: string;
  }): Promise<void> {
    await this.safely("processing.recorded", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      await this.fanOut(
        staff,
        "Processing recorded",
        `${input.method} processing recorded for batch ${input.batchCode}.`
      );
    });
  }

  /** A batch entered warehouse storage. */
  async notifyWarehouseStored(input: {
    cooperativeId: string;
    batchCode: string;
    warehouseName: string;
    weightKg: number;
    actorId?: string;
  }): Promise<void> {
    await this.safely("warehouse.stored", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      await this.fanOut(
        staff,
        "Batch stored",
        `Batch ${input.batchCode} (${input.weightKg} kg) stored at ${input.warehouseName}.`
      );
    });
  }

  /** An ownership transfer was initiated and is awaiting confirmation. */
  async notifyTransferInitiated(input: {
    cooperativeId: string;
    batchCode: string;
    buyerName: string;
    actorId?: string;
  }): Promise<void> {
    await this.safely("transfer.initiated", async () => {
      const admins = await this.recipientsIn(input.cooperativeId, [ROLES.COOPERATIVE_ADMIN], input.actorId);
      await this.fanOut(
        admins,
        "Sale awaiting confirmation",
        `A transfer of batch ${input.batchCode} to ${input.buyerName} is pending confirmation.`
      );
    });
  }

  /** An ownership transfer was confirmed — the sale is final. */
  async notifyTransferConfirmed(input: {
    batchId: string;
    cooperativeId: string;
    batchCode: string;
    buyerName: string;
    initiatedById?: string | null;
    actorId?: string;
  }): Promise<void> {
    await this.safely("transfer.confirmed", async () => {
      const staff = await this.recipientsIn(input.cooperativeId, OPS_ROLES, input.actorId);
      await this.fanOut(
        staff,
        "Sale confirmed",
        `Batch ${input.batchCode} has been sold to ${input.buyerName}.`
      );

      // The person who opened the transfer is told the outcome even if someone
      // else confirmed it — they're waiting on this specific answer.
      const initiator = input.initiatedById;
      if (initiator && initiator !== input.actorId && !staff.includes(initiator)) {
        await this.create({
          userId: initiator,
          title: "Sale confirmed",
          message: `The transfer you initiated for batch ${input.batchCode} to ${input.buyerName} was confirmed.`,
        });
      }

      // The farmers whose deliveries make up this batch are the people the sale
      // actually belongs to. Confirmation happens inside a transaction that
      // bypasses updateBatchStatus, so this is the only place they hear about it.
      await this.notifyContributingFarmers(
        input.batchId,
        "Your coffee has been sold",
        `Batch ${input.batchCode}, which includes your deliveries, has been sold to ${input.buyerName}.`,
        input.actorId
      );
    });
  }

  /** A user's account status changed (suspended, reactivated, verified). */
  async notifyUserStatusChange(userId: string, newStatus: string, actorId?: string): Promise<void> {
    if (userId === actorId) return;
    await this.safely("user.status", () =>
      this.create({
        userId,
        title: "Account status changed",
        message: `Your account status is now ${newStatus}.`,
      })
    );
  }

  /**
   * System-wide announcement (maintenance windows). Goes to every active user,
   * which is the one case where a global fan-out is correct.
   */
  async notifySystemEvent(title: string, message: string, actorId?: string): Promise<void> {
    await this.safely("system.event", async () => {
      const users = await prisma.user.findMany({
        where: { status: "ACTIVE", isDeleted: false, ...(actorId && { id: { not: actorId } }) },
        select: { id: true },
      });
      await this.fanOut(users.map((u) => u.id), title, message);
    });
  }

  /**
   * Notify every farmer with a linked user account whose deliveries are part of
   * the given batch. Farmers without accounts are silently skipped.
   */
  private async notifyContributingFarmers(
    batchId: string,
    title: string,
    message: string,
    actorId?: string
  ): Promise<void> {
    const deliveries = await prisma.delivery.findMany({
      where: { batchId, farmer: { userId: { not: null } } },
      select: { farmer: { select: { userId: true } } },
      distinct: ["farmerId"],
    });

    const userIds = [
      ...new Set(
        deliveries
          .map((d) => d.farmer.userId)
          .filter((id): id is string => !!id && id !== actorId)
      ),
    ];
    await this.fanOut(userIds, title, message);
  }
}

export const notificationService = new NotificationService();
