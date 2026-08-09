import { Prisma } from "@prisma/client";
import { prisma } from "@/repositories/prisma.client";

/**
 * Generates human-readable, per-year sequential entity codes
 * (`BATCH-2026-00001`, `DEL-2026-000001`, `FARM-2026-00001`).
 *
 * Numbering is delegated to the `next_entity_code` SQL function, which
 * atomically increments a per-scope counter row. This matters because the
 * previous COUNT(*)-based approach let two concurrent registrations derive the
 * same number — the loser hit a unique-constraint error — and let numbering
 * move backwards after a deletion, colliding with historical codes.
 *
 * Pass the surrounding transaction client when generating a code inside a
 * transaction so the counter increments and the row insert commit together.
 */
export async function nextEntityCode(
  entity: "batch" | "delivery" | "farmer",
  prefix: string,
  padding: number,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await client.$queryRaw<{ next_entity_code: bigint }[]>`
    SELECT next_entity_code(${`${entity}:${year}`}) AS next_entity_code
  `;

  const sequence = Number(rows[0].next_entity_code);
  return `${prefix}-${year}-${String(sequence).padStart(padding, "0")}`;
}
