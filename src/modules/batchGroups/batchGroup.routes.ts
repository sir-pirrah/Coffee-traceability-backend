import { Router } from "express";
import { z } from "zod";
import { Prisma, BatchStatus } from "@prisma/client";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { scopeCooperativeId, assertOwnership } from "@/middleware/scopeHelpers";
import { validate } from "@/middleware/validate";
import { asyncHandler } from "@/utils/asyncHandler";
import { sendSuccess } from "@/utils/apiResponse";
import { ApiError } from "@/utils/ApiError";
import { prisma, withTransaction } from "@/repositories/prisma.client";
import { nextEntityCode } from "@/utils/entityCode";
import { notificationService } from "@/modules/notifications/notification.service";
import { recordAuditLog } from "@/modules/auditLogs/auditLog.service";
import {
  ConfirmTransferResult,
  confirmTransferInTx,
  recordTransferConfirmedEvents,
} from "@/modules/ownershipTransfers/ownershipTransfer.service";

const router = Router();
router.use(...protect);

// Fields of a member batch surfaced through a lot. Deliberately excludes prices
// and anything PII-adjacent — a lot is an internal operational bundle, and the
// combined weight it reports is derived from `totalWeightKg` alone.
const BATCH_SELECT: Prisma.CoffeeBatchSelect = {
  id: true,
  batchCode: true,
  status: true,
  totalWeightKg: true,
  originRegion: true,
  harvestSeason: true,
};

// A batch that has already left the cooperative's hands cannot join a new lot.
const TERMINAL_STATUSES: BatchStatus[] = ["SOLD", "EXPORTED", "REJECTED"];

// Selling drives each member to SOLD, which the batch state machine permits only
// from these two statuses.
const SELLABLE_STATUSES: BatchStatus[] = ["IN_STORAGE", "IN_TRANSIT"];

const createSchema = z.object({
  body: z.object({
    // A lot combines batches, so two is the floor; duplicates are rejected so a
    // repeated id cannot inflate the member count or trip the unique index.
    batchIds: z
      .array(z.string().uuid())
      .min(2)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate batch IDs are not allowed"),
    note: z.string().max(500).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const sellSchema = z.object({
  body: z.object({
    buyerId: z.string().uuid(),
    salePricePerKg: z.coerce.number().positive().optional(),
    fromEntityType: z.enum(["COOPERATIVE", "WAREHOUSE", "BUYER"]),
    fromEntityId: z.string().uuid(),
  }),
  params: z.object({ id: z.string().uuid() }),
  query: z.object({}).optional(),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  query: z.object({}).optional(),
  body: z.object({}).optional(),
});

const listSchema = z.object({
  query: z.object({ cooperativeId: z.string().uuid().optional() }).optional(),
  params: z.object({}).optional(),
  body: z.object({}).optional(),
});

// Prisma returns Decimal for weight columns; sum them as numbers and round to the
// two-decimal storage precision so floating-point noise never leaks into the
// reported total.
function kg(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100) / 100;
}

interface MemberWeight {
  batch: { totalWeightKg: Prisma.Decimal | number | null };
}

// The combined weight of a lot is Σ(member.totalWeightKg), computed on read and
// never stored, so it can never drift from the batches the lot points at.
function serializeGroup<T extends { members: MemberWeight[] }>(group: T): T & { combinedWeightKg: number } {
  const combinedWeightKg = kg(group.members.reduce((sum, m) => sum + Number(m.batch.totalWeightKg ?? 0), 0));
  return { ...group, combinedWeightKg };
}

// Create a lot from a set of batches. The originals are untouched: a lot only
// references them, so each member keeps its own identity, status, and
// traceability. Combining is additive — nothing is consumed.
router.post(
  "/",
  requirePermission("lots:manage"),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { batchIds, note } = req.body as { batchIds: string[]; note?: string };

    // Fetch every batch up front so one bad id fails the whole create rather than
    // leaving a half-formed lot. RLS already hides other tenants' batches, so a
    // hidden id simply drops out of the result and is reported as missing below.
    const batches = await prisma.coffeeBatch.findMany({
      where: { id: { in: batchIds }, isDeleted: false },
      select: { id: true, cooperativeId: true, batchCode: true, status: true },
    });
    if (batches.length !== batchIds.length) {
      const found = new Set(batches.map((b) => b.id));
      const missing = batchIds.filter((id) => !found.has(id));
      throw ApiError.notFound(`Coffee batch(es) not found: ${missing.join(", ")}`);
    }

    // A lot belongs to one cooperative; assertOwnership pins every member to the
    // caller's tenant (SUPER_ADMIN excepted).
    for (const batch of batches) assertOwnership(req, batch);
    const cooperativeId = batches[0].cooperativeId;

    const ineligible = batches.filter((b) => TERMINAL_STATUSES.includes(b.status));
    if (ineligible.length > 0) {
      throw ApiError.badRequest(
        `Cannot group batch(es) ${ineligible.map((b) => b.batchCode).join(", ")} — ` +
          "a sold, exported, or rejected batch cannot be added to a lot."
      );
    }

    const group = await withTransaction(async (tx: Prisma.TransactionClient) => {
      // Generate the code inside the transaction so the counter increment and the
      // row insert commit together.
      const groupCode = await nextEntityCode("group", "LOT", 5, tx);
      return tx.batchGroup.create({
        data: {
          groupCode,
          cooperativeId,
          note,
          createdById: req.user!.id,
          members: { create: batchIds.map((batchId) => ({ batchId })) },
        },
        include: { members: { include: { batch: { select: BATCH_SELECT } } } },
      });
    });

    await recordAuditLog({ req, action: "CREATE", entityType: "BatchGroup", entityId: group.id });
    sendSuccess(res, serializeGroup(group), 201);
  })
);

router.get(
  "/",
  requirePermission("lots:view"),
  validate(listSchema),
  asyncHandler(async (req, res) => {
    // Pin non-SUPER_ADMIN callers to their own cooperative so an omitted or
    // forged cooperativeId cannot widen the list beyond their scope.
    const cooperativeId = scopeCooperativeId(req, req.query.cooperativeId as string | undefined);
    const groups = await prisma.batchGroup.findMany({
      where: { cooperativeId },
      include: { members: { include: { batch: { select: BATCH_SELECT } } } },
      orderBy: { createdAt: "desc" },
    });
    sendSuccess(res, groups.map(serializeGroup));
  })
);

router.get(
  "/:id",
  requirePermission("lots:view"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const group = await prisma.batchGroup.findUnique({
      where: { id: req.params.id },
      include: { members: { include: { batch: { select: BATCH_SELECT } } } },
    });
    if (!group) throw ApiError.notFound("Lot not found");
    assertOwnership(req, group);
    sendSuccess(res, serializeGroup(group));
  })
);

// Put a lot up for sale: open one PENDING ownership transfer per member batch.
// Each batch gets its own transfer row, so a lot sale and a single-batch sale
// finalise through identical per-batch logic — members never lose their
// individual traceability.
router.post(
  "/:id/sell",
  requirePermission("lots:manage"),
  validate(sellSchema),
  asyncHandler(async (req, res) => {
    const { buyerId, salePricePerKg, fromEntityType, fromEntityId } = req.body;

    const group = await prisma.batchGroup.findUnique({
      where: { id: req.params.id },
      include: {
        members: { include: { batch: { select: { id: true, batchCode: true, status: true } } } },
      },
    });
    if (!group) throw ApiError.notFound("Lot not found");
    assertOwnership(req, group);
    if (group.status === "SOLD") throw ApiError.badRequest("This lot has already been sold.");
    if (group.members.length === 0) throw ApiError.badRequest("This lot has no batches to sell.");

    const buyer = await prisma.buyer.findUnique({
      where: { id: buyerId },
      select: { id: true, companyName: true },
    });
    if (!buyer) throw ApiError.notFound("Buyer not found");

    // Reject the whole lot — naming the offenders — rather than selling the
    // sellable members and silently skipping the rest.
    const notSellable = group.members.filter((m) => !SELLABLE_STATUSES.includes(m.batch.status));
    if (notSellable.length > 0) {
      throw ApiError.badRequest(
        `Cannot sell this lot — batch(es) ${notSellable.map((m) => m.batch.batchCode).join(", ")} ` +
          "must be in storage or in transit before they can be sold."
      );
    }

    // A member already awaiting confirmation would give confirm-sale two PENDING
    // transfers to choose between. Keep it one-to-one by refusing to open a
    // second sale over an outstanding one.
    const batchIds = group.members.map((m) => m.batch.id);
    const existingPending = await prisma.ownershipTransfer.findMany({
      where: { batchId: { in: batchIds }, status: "PENDING" },
      include: { batch: { select: { batchCode: true } } },
    });
    if (existingPending.length > 0) {
      throw ApiError.badRequest(
        `Cannot sell this lot — batch(es) ${existingPending.map((t) => t.batch.batchCode).join(", ")} ` +
          "already have a pending sale awaiting confirmation."
      );
    }

    const transfers = await withTransaction(async (tx: Prisma.TransactionClient) =>
      Promise.all(
        batchIds.map((batchId) =>
          tx.ownershipTransfer.create({
            data: { batchId, fromEntityType, fromEntityId, buyerId, salePricePerKg, initiatedById: req.user!.id },
          })
        )
      )
    );

    await notificationService.notifyTransferInitiated({
      cooperativeId: group.cooperativeId,
      batchCode: `lot ${group.groupCode}`,
      buyerName: buyer.companyName,
      actorId: req.user!.id,
    });
    await recordAuditLog({
      req,
      action: "CREATE",
      entityType: "BatchGroup",
      entityId: group.id,
      metadata: { event: "sell", transferIds: transfers.map((t) => t.id) },
    });
    sendSuccess(res, { groupId: group.id, transfers }, 201);
  })
);

// Confirm a lot's sale: finalise every member's PENDING transfer. The whole lot
// confirms in one transaction, so if a single member cannot be finalised the lot
// rolls back rather than being left half-sold. Each member still flips to SOLD
// through the shared confirm chokepoint — closing its warehouse row and chaining
// its own ledger events — exactly as a single-batch confirmation would.
router.post(
  "/:id/confirm-sale",
  requirePermission("lots:manage"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const group = await prisma.batchGroup.findUnique({
      where: { id: req.params.id },
      include: { members: { select: { batchId: true } } },
    });
    if (!group) throw ApiError.notFound("Lot not found");
    assertOwnership(req, group);
    if (group.status === "SOLD") throw ApiError.badRequest("This lot has already been sold.");
    if (group.members.length === 0) throw ApiError.badRequest("This lot has no batches to confirm.");

    // sell() guarantees at most one PENDING transfer per member, so this gathers
    // exactly the transfers it opened.
    const batchIds = group.members.map((m) => m.batchId);
    const pending = await prisma.ownershipTransfer.findMany({
      where: { batchId: { in: batchIds }, status: "PENDING" },
      select: { id: true },
    });
    if (pending.length === 0) {
      throw ApiError.badRequest("This lot has no pending sale to confirm. Record a sale for the lot first.");
    }

    const results = await withTransaction(async (tx: Prisma.TransactionClient) => {
      const confirmed: ConfirmTransferResult[] = [];
      for (const t of pending) {
        confirmed.push(await confirmTransferInTx(tx, t.id));
      }
      await tx.batchGroup.update({ where: { id: group.id }, data: { status: "SOLD" } });
      return confirmed;
    });

    // Ledger events and notifications run after the transaction commits:
    // recordBlockchainEvent opens its own hashing transaction and must not nest,
    // and a notification failure must never roll back a committed sale.
    for (const result of results) {
      await recordTransferConfirmedEvents(result);
      await notificationService.notifyTransferConfirmed({
        batchId: result.updated.batchId,
        cooperativeId: result.cooperativeId,
        batchCode: result.batchCode,
        buyerName: result.buyerName ?? "a buyer",
        initiatedById: result.updated.initiatedById,
        actorId: req.user!.id,
      });
    }

    await recordAuditLog({ req, action: "UPDATE", entityType: "BatchGroup", entityId: group.id });

    const updated = await prisma.batchGroup.findUnique({
      where: { id: group.id },
      include: { members: { include: { batch: { select: BATCH_SELECT } } } },
    });
    sendSuccess(res, serializeGroup(updated!));
  })
);

export default router;
