import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Report #1 — Operations Summary: a cooperative health check. Active farmers,
 * deliveries and delivered weight for a period, batch counts by status, and the
 * average weight per delivery.
 *
 * The route asserts the caller owns `cooperativeId` before calling in, so no
 * query here can cross a cooperative boundary.
 */

export interface OperationsSummary {
  totalDeliveries: number;
  totalWeightKg: number;
  avgWeightPerDelivery: number;
  activeFarmers: number;
  batchesByStatus: { status: string; count: number }[];
  period: { from: string | null; to: string | null } | null;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100) / 100;
}

export async function getOperationsSummary(
  cooperativeId: string,
  range: { from?: Date; to?: Date } = {}
): Promise<OperationsSummary> {
  // A period filter narrows deliveries by delivery date; batch status counts
  // and the active-farmer headcount are always "as of now".
  const deliveryDateFilter =
    range.from || range.to
      ? { deliveryDate: { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) } }
      : {};

  const [deliveryAgg, batchStatusCounts, farmerCount] = await Promise.all([
    prisma.delivery.aggregate({
      where: { cooperativeId, ...deliveryDateFilter },
      _sum: { weightKg: true },
      _count: { _all: true },
    }),
    prisma.coffeeBatch.groupBy({
      by: ["status"],
      where: { cooperativeId, isDeleted: false },
      _count: { _all: true },
    }),
    prisma.farmer.count({ where: { cooperativeId, isDeleted: false, isActive: true } }),
  ]);

  const totalDeliveries = deliveryAgg._count._all;
  const totalWeightKg = toNumber(deliveryAgg._sum.weightKg);

  return {
    totalDeliveries,
    totalWeightKg,
    avgWeightPerDelivery: totalDeliveries > 0 ? Math.round((totalWeightKg / totalDeliveries) * 100) / 100 : 0,
    activeFarmers: farmerCount,
    batchesByStatus: batchStatusCounts.map((b) => ({ status: b.status, count: b._count._all })),
    period:
      range.from || range.to
        ? { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null }
        : null,
  };
}
