/**
 * Immutability proof for the proposal's criterion:
 * "blockchain records cannot be edited through the app".
 *
 * Runs every realistic tampering attempt against blockchain_transactions using
 * the application's own Prisma connection — the same credentials the API uses.
 * Every attempt must be rejected by the database trigger. Run with:
 *   npx tsx scripts/tamper-test.ts
 */
import { prisma } from "../src/repositories/prisma.client";
import { verifyChain } from "../src/blockchain/blockchain.service";

let passed = 0;
let failed = 0;

async function mustReject(label: string, attempt: () => Promise<unknown>) {
  try {
    await attempt();
    failed++;
    console.log(`  ✗ FAIL  ${label}\n          → the write SUCCEEDED; ledger is mutable!`);
  } catch (err) {
    const msg = (err as Error).message.replace(/\s+/g, " ");
    const guard = msg.match(/blockchain_transactions are immutable: [^"]*/)?.[0] ?? msg.slice(0, 90);
    passed++;
    console.log(`  ✓ PASS  ${label}\n          → rejected: ${guard.trim()}`);
  }
}

async function main() {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { blockchainTxs: { some: {} } },
    select: { id: true, batchCode: true },
  });
  if (!batch) throw new Error("No batch with ledger events found — create one first.");

  const rows = await prisma.blockchainTransaction.findMany({
    where: { batchId: batch.id },
    orderBy: { submittedAt: "asc" },
    select: { id: true, eventType: true, status: true, blockHash: true },
  });

  console.log(`\nBatch ${batch.batchCode} — ${rows.length} ledger events`);
  const before = await verifyChain(batch.id);
  console.log(`Chain valid before tampering: ${before.valid}\n`);

  const target = rows[0];
  console.log("Tampering attempts (all must be rejected):");

  await mustReject("UPDATE payload (rewrite history)", () =>
    prisma.blockchainTransaction.update({
      where: { id: target.id },
      data: { payload: { hacked: true } },
    })
  );

  await mustReject("UPDATE block_hash (forge a hash)", () =>
    prisma.$executeRaw`UPDATE blockchain_transactions SET block_hash = 'deadbeef' WHERE id = ${target.id}::uuid`
  );

  await mustReject("UPDATE previous_hash (re-link the chain)", () =>
    prisma.$executeRaw`UPDATE blockchain_transactions SET previous_hash = NULL WHERE id = ${target.id}::uuid`
  );

  await mustReject("UPDATE event_type (relabel an event)", () =>
    prisma.$executeRaw`UPDATE blockchain_transactions SET event_type = 'SALE_RECORDED' WHERE id = ${target.id}::uuid`
  );

  await mustReject("UPDATE submitted_at (backdate an event)", () =>
    prisma.$executeRaw`UPDATE blockchain_transactions SET submitted_at = NOW() - INTERVAL '30 days' WHERE id = ${target.id}::uuid`
  );

  await mustReject("UPDATE status on a CONFIRMED row (re-settle)", () =>
    prisma.blockchainTransaction.update({
      where: { id: target.id },
      data: { status: "FAILED" },
    })
  );

  await mustReject("DELETE a single event (erase a step)", () =>
    prisma.blockchainTransaction.delete({ where: { id: target.id } })
  );

  await mustReject("DELETE the whole batch ledger (wipe history)", () =>
    prisma.$executeRaw`DELETE FROM blockchain_transactions WHERE batch_id = ${batch.id}::uuid`
  );

  const after = await verifyChain(batch.id);
  const stillThere = await prisma.blockchainTransaction.count({ where: { batchId: batch.id } });

  console.log(`\nAfter all attempts: ${stillThere}/${rows.length} events intact, chainValid=${after.valid}`);
  console.log(`Result: ${passed} rejected, ${failed} succeeded (any success is a failure).\n`);

  await prisma.$disconnect();
  process.exit(failed === 0 && after.valid && stillThere === rows.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
