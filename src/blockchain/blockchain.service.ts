import crypto from "node:crypto";
import { prisma, withTransaction } from "@/repositories/prisma.client";
import { env } from "@/config/env";
import { logger } from "@/config/logger";
import { BlockchainEventType, Prisma } from "@prisma/client";

/**
 * Blockchain abstraction layer.
 *
 * This module isolates all ledger interaction behind one interface so the
 * rest of the app never talks to Hyperledger Fabric / Ethereum directly.
 * When BLOCKCHAIN_ENABLED=false (e.g. early development, CI, demos), it
 * still writes an auditable, hash-chained record to Postgres so the rest
 * of the system (QR verification, reports) works end-to-end. Swap
 * `submitToLedger` for a real Fabric Gateway / ethers.js call when the
 * network is ready — nothing else in the codebase needs to change.
 *
 * Phase 2 adds a per-batch **tamper-evident hash-chain**: each event links
 * to the previous event's `blockHash`, and editing any past event breaks
 * the hash of every event after it. `verifyChain` detects tampering.
 */

function hashPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function computeBlockHash(data: {
  previousHash: string | null;
  payloadHash: string;
  eventType: string;
  batchId: string;
  submittedAt: Date;
}): string {
  const parts = [
    data.previousHash ?? "genesis",
    data.payloadHash,
    data.eventType,
    data.batchId,
    data.submittedAt.toISOString(),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

async function submitToLedger(blockHash: string): Promise<string> {
  if (!env.BLOCKCHAIN_ENABLED) {
    // Deterministic pseudo-hash so behavior is stable in dev/test. Derived from
    // `blockHash`, NOT `payloadHash`: `tx_hash` is UNIQUE, and two events with
    // identical payloads (e.g. `{"method":"WASHED"}` on two batches) hash the
    // same payload — so a payload-derived mock collided, the settle UPDATE
    // failed, and both events were recorded as FAILED. `blockHash` folds in the
    // batch, timestamp, and predecessor, so it is unique per event.
    return `mock_${blockHash.slice(0, 32)}`;
  }
  // TODO: integrate real Fabric/Ethereum client here, e.g.:
  // const gateway = await connectToFabric(env.BLOCKCHAIN_NETWORK, env.BLOCKCHAIN_CHANNEL);
  // const network = await gateway.getNetwork(env.BLOCKCHAIN_CHANNEL);
  // const contract = network.getContract(env.BLOCKCHAIN_CONTRACT);
  // const result = await contract.submitTransaction("recordEvent", blockHash);
  // return result.toString();
  throw new Error("Real blockchain integration not yet configured");
}

export async function recordBlockchainEvent(
  batchId: string,
  eventType: BlockchainEventType,
  payload: Prisma.InputJsonValue
): Promise<void> {
  const payloadHash = hashPayload(payload);

  // 1. Chain + insert inside a short transaction. The advisory lock serializes
  //    concurrent events for the SAME batch so two events can't read the same
  //    predecessor and fork the chain. Deliberately does NOT wrap the ledger
  //    call — that's a network round-trip and must not hold a DB lock open.
  const txRecord = await withTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${batchId}))`;

    const predecessor = await tx.blockchainTransaction.findFirst({
      where: { batchId },
      orderBy: { submittedAt: "desc" },
      select: { blockHash: true },
    });

    const previousHash = predecessor?.blockHash ?? null;
    const submittedAt = new Date();
    const blockHash = computeBlockHash({ previousHash, payloadHash, eventType, batchId, submittedAt });

    return tx.blockchainTransaction.create({
      data: { batchId, eventType, payloadHash, previousHash, blockHash, payload, status: "PENDING", submittedAt },
    });
  });

  // 2. Submit to the ledger (or mock) outside the transaction, then settle the
  //    record. This PENDING → CONFIRMED/FAILED update is the only mutation the
  //    immutability trigger permits.
  try {
    const txHash = await submitToLedger(txRecord.blockHash);
    await prisma.blockchainTransaction.update({
      where: { id: txRecord.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
  } catch (err) {
    logger.error({ err, batchId, eventType }, "Blockchain submission failed");
    await prisma.blockchainTransaction.update({
      where: { id: txRecord.id },
      data: { status: "FAILED", errorMessage: (err as Error).message },
    });
  }
}

/**
 * Verify the tamper-evident hash-chain for a batch. Recomputes every block
 * from scratch and confirms each links to its predecessor. Returns
 * `{valid: true}` if the chain is intact, or `{valid: false, brokenAt: <id>}`
 * if a hash mismatch is found (evidence of tampering or corruption).
 */
export async function verifyChain(batchId: string): Promise<{ valid: boolean; brokenAt?: string }> {
  const events = await prisma.blockchainTransaction.findMany({
    where: { batchId },
    orderBy: { submittedAt: "asc" },
    select: { id: true, previousHash: true, blockHash: true, payloadHash: true, eventType: true, submittedAt: true },
  });

  let expectedPreviousHash: string | null = null;
  for (const event of events) {
    // Check predecessor link.
    if (event.previousHash !== expectedPreviousHash) {
      return { valid: false, brokenAt: event.id };
    }
    // Recompute this event's block hash and compare.
    const recomputed = computeBlockHash({
      previousHash: event.previousHash,
      payloadHash: event.payloadHash,
      eventType: event.eventType,
      batchId,
      submittedAt: event.submittedAt,
    });
    if (recomputed !== event.blockHash) {
      return { valid: false, brokenAt: event.id };
    }
    expectedPreviousHash = event.blockHash;
  }

  return { valid: true };
}
