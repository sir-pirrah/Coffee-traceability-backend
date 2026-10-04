import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Report #6 — Sales & Transfer Ledger: revenue visibility, Admin-only (gated by
 * the `reports:financial` permission at the route). Per transfer: the batch,
 * buyer, sale price/kg, total value, and transfer status.
 *
 * Total value = salePricePerKg × the batch's total weight. Prices are nullable
 * (a transfer can be recorded before a price is agreed), in which case the row
 * value is 0 and the price is reported as null.
 */

export interface SalesLedgerRow {
  batchCode: string;
  buyerName: string | null;
  country: string | null;
  salePricePerKg: number | null;
  batchWeightKg: number;
  totalValue: number;
  status: string;
  transferredAt: string;
}

export interface SalesLedger {
  rows: SalesLedgerRow[];
  totals: { confirmedValue: number; pendingValue: number };
  period: { from: string | null; to: string | null } | null;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function getSalesLedger(
  cooperativeId: string,
  range: { from?: Date; to?: Date } = {}
): Promise<SalesLedger> {
  const transfers = await prisma.ownershipTransfer.findMany({
    where: {
      batch: { cooperativeId, isDeleted: false },
      ...((range.from || range.to) && {
        transferredAt: { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) },
      }),
    },
    select: {
      salePricePerKg: true,
      status: true,
      transferredAt: true,
      batch: { select: { batchCode: true, totalWeightKg: true } },
      buyer: { select: { companyName: true, country: true } },
    },
    orderBy: { transferredAt: "desc" },
  });

  const rows: SalesLedgerRow[] = transfers.map((t) => {
    const batchWeightKg = toNumber(t.batch.totalWeightKg);
    const price = t.salePricePerKg !== null ? toNumber(t.salePricePerKg) : null;
    return {
      batchCode: t.batch.batchCode,
      buyerName: t.buyer?.companyName ?? null,
      country: t.buyer?.country ?? null,
      salePricePerKg: price,
      batchWeightKg: round2(batchWeightKg),
      totalValue: price !== null ? round2(price * batchWeightKg) : 0,
      status: t.status,
      transferredAt: t.transferredAt.toISOString(),
    };
  });

  return {
    rows,
    totals: {
      confirmedValue: round2(rows.filter((r) => r.status === "CONFIRMED").reduce((s, r) => s + r.totalValue, 0)),
      pendingValue: round2(rows.filter((r) => r.status === "PENDING").reduce((s, r) => s + r.totalValue, 0)),
    },
    period:
      range.from || range.to
        ? { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null }
        : null,
  };
}
