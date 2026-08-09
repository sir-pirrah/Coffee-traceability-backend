import { Request } from "express";
import { ApiError } from "@/utils/ApiError";
import { prisma } from "@/repositories/prisma.client";
import { getDbContext, runAsSystem } from "@/repositories/dbContext";

/**
 * Returns the cooperative ID that should scope a query, given the authenticated
 * user and an optional caller-supplied cooperativeId filter.
 *
 * - SUPER_ADMIN: can read any cooperative's data, so returns the supplied ID
 *   (or undefined to read all).
 * - Other roles: can only read their own cooperative, so returns their
 *   cooperativeId regardless of what was requested.
 *
 * This ensures that a COOPERATIVE_ADMIN from Coop A passing `?cooperativeId=B`
 * in the URL still only sees Coop A's data.
 *
 * Fails closed: `User.cooperativeId` is nullable, and returning `undefined` for
 * an unaffiliated non-admin would drop the filter entirely and expose every
 * cooperative's records. Such a user has no scope to read, so we reject.
 */
export function scopeCooperativeId(req: Request, requestedId?: string): string | undefined {
  if (!req.user) throw ApiError.unauthorized();
  if (req.user.role === "SUPER_ADMIN") return requestedId;
  if (!req.user.cooperativeId) {
    throw ApiError.forbidden("Your account is not linked to a cooperative");
  }
  return req.user.cooperativeId;
}

/**
 * Verifies that a record belongs to the caller's cooperative. Use this in
 * getById-style handlers after fetching a record that has a `cooperativeId`
 * field: if the caller is not SUPER_ADMIN and the record's cooperativeId
 * doesn't match theirs, throw 403.
 *
 * Example:
 *   const batch = await getBatchById(id);
 *   assertOwnership(req, batch);
 */
export function assertOwnership(req: Request, record: { cooperativeId: string } | null): void {
  if (!req.user) throw ApiError.unauthorized();
  if (req.user.role === "SUPER_ADMIN") return;
  if (!record) return; // notFound already thrown by the caller
  // An unaffiliated non-admin can never match a record's owning cooperative.
  if (!req.user.cooperativeId || record.cooperativeId !== req.user.cooperativeId) {
    throw ApiError.forbidden("You cannot access another cooperative's data");
  }
}

/**
 * Verifies that a record reached via a join (e.g. ProcessingRecord -> batch)
 * belongs to the caller's cooperative. The record must have a nested
 * `.batch.cooperativeId` or similar path.
 *
 * Example:
 *   const processingRecord = await prisma.processingRecord.findUnique({
 *     where: { id }, include: { batch: { select: { cooperativeId: true } } }
 *   });
 *   assertOwnershipVia(req, processingRecord, (r) => r?.batch?.cooperativeId);
 */
export function assertOwnershipVia<T>(
  req: Request,
  record: T | null,
  getCooperativeId: (record: T | null) => string | undefined
): void {
  if (!req.user) throw ApiError.unauthorized();
  if (req.user.role === "SUPER_ADMIN") return;
  const coopId = getCooperativeId(record);
  if (coopId && coopId !== req.user.cooperativeId) {
    throw ApiError.forbidden("You cannot access another cooperative's data");
  }
}

/**
 * Resolves a FARMER user to the id of the Farmer record they are, or `null` for
 * every other role.
 *
 * Cooperative scoping alone is too coarse for a farmer: it would show them every
 * other member's deliveries. A farmer is a *member* of the cooperative, not a
 * clerk of it, so their reads are narrowed one level further — to the rows tied
 * to their own `Farmer` profile.
 *
 * Returning `null` for non-farmers is what keeps callers simple: they apply the
 * extra filter only when there is one, and staff/admin reads are untouched.
 *
 * A FARMER whose account was never linked to a Farmer profile has no rows to
 * see, so this fails closed rather than silently widening to the whole
 * cooperative.
 */
export async function farmerScopeId(req: Request): Promise<string | null> {
  if (!req.user) throw ApiError.unauthorized();
  if (req.user.role !== "FARMER") return null;

  // Resolved once per request by `protect` and cached on the RLS context, both
  // to save the repeated lookup and because the row-level policies need the
  // value before any farmer-scoped query can run.
  const cached = getDbContext()?.farmerId;
  if (cached) return cached;

  // The lookup runs in system context to break a chicken-and-egg: the `farmers`
  // policy narrows a farmer to their own row by id, and the id is what we are
  // trying to find. Scoped to this one query by user id, which is trustworthy —
  // it comes from the verified token.
  const farmer = await runAsSystem(() =>
    prisma.farmer.findFirst({
      where: { userId: req.user!.id, isDeleted: false },
      select: { id: true },
    })
  );
  if (!farmer) {
    throw ApiError.forbidden(
      "Your account isn't linked to a farmer profile yet, so there are no records to show. " +
        "Ask your cooperative to link it."
    );
  }
  return farmer.id;
}

/**
 * Rejects a farmer's attempt to read a record belonging to another farmer.
 * `scopeFarmerId` is the value from `farmerScopeId` — `null` means the caller
 * isn't a farmer, so the check doesn't apply.
 */
export function assertFarmerOwnership(scopeFarmerId: string | null, recordFarmerId: string | undefined): void {
  if (scopeFarmerId === null) return;
  if (recordFarmerId !== scopeFarmerId) {
    throw ApiError.forbidden("You can only view your own deliveries");
  }
}
