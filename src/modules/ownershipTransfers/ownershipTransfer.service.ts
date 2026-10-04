import { Prisma, OwnershipTransfer } from "@prisma/client";
import { ApiError } from "@/utils/ApiError";
import { recordBlockchainEvent } from "@/blockchain/blockchain.service";
import { transitionBatchStatus } from "@/modules/coffeeBatches/coffeeBatch.service";

/**
 * The outcome of confirming one transfer inside a transaction: the full updated
 * row (for the API response) plus the few related fields the post-commit
 * effects need but that do not live on the transfer row itself.
 */
export interface ConfirmTransferResult {
  updated: OwnershipTransfer;
  batchCode: string;
  cooperativeId: string;
  buyerName: string | null;
}

/**
 * Confirms a single PENDING ownership transfer inside the caller's transaction:
 * stamps it CONFIRMED with the moment custody actually changed, and drives the
 * batch to SOLD through the shared state-machine chokepoint — which, in the same
 * transaction, closes any open warehouse inventory row so the "In Storage" KPI
 * stops counting coffee that has been sold.
 *
 * Throws if the transfer is missing or no longer PENDING, so a group confirm
 * that fans out over several members aborts the whole transaction instead of
 * leaving the lot half-sold.
 *
 * The ledger events are deliberately NOT written here — recordBlockchainEvent
 * runs its own hashing transaction and must not be nested. Call
 * {@link recordTransferConfirmedEvents} with the result after the transaction
 * commits.
 */
export async function confirmTransferInTx(
  tx: Prisma.TransactionClient,
  transferId: string
): Promise<ConfirmTransferResult> {
  const transfer = await tx.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: {
      batch: { select: { cooperativeId: true, batchCode: true } },
      buyer: { select: { companyName: true } },
    },
  });
  if (!transfer) throw ApiError.notFound("Transfer not found");
  if (transfer.status !== "PENDING") throw ApiError.badRequest("Transfer already finalized");

  const updated = await tx.ownershipTransfer.update({
    where: { id: transfer.id },
    // Stamp the moment custody actually changed. The movement chart buckets the
    // Sold series by `transferred_at`; leaving it to the column default dates the
    // sale to when the transfer was *drafted*, which drops a sale confirmed in a
    // later month into the wrong column.
    data: { status: "CONFIRMED", transferredAt: new Date() },
  });
  // Confirming a sale can only happen from IN_STORAGE or IN_TRANSIT — the state
  // machine blocks a batch being sold straight out of REGISTERED.
  await transitionBatchStatus(tx, transfer.batchId, "SOLD");

  return {
    updated,
    batchCode: transfer.batch.batchCode,
    cooperativeId: transfer.batch.cooperativeId,
    buyerName: transfer.buyer?.companyName ?? null,
  };
}

/**
 * Chains the ledger events for a confirmed transfer: the change of custody, then
 * — when money changed hands — a distinct SALE_RECORDED event so the ledger
 * distinguishes a transfer from a sale (both are required by the proposal).
 *
 * Call AFTER the confirming transaction commits.
 */
export async function recordTransferConfirmedEvents(result: ConfirmTransferResult): Promise<void> {
  const { updated } = result;

  await recordBlockchainEvent(updated.batchId, "OWNERSHIP_TRANSFERRED", {
    transferId: updated.id,
    buyerId: updated.buyerId,
    fromEntityType: updated.fromEntityType,
    transferredAt: new Date().toISOString(),
  });

  if (updated.salePricePerKg != null) {
    await recordBlockchainEvent(updated.batchId, "SALE_RECORDED", {
      transferId: updated.id,
      buyerId: updated.buyerId,
      salePricePerKg: updated.salePricePerKg.toString(),
      recordedAt: new Date().toISOString(),
    });
  }
}
