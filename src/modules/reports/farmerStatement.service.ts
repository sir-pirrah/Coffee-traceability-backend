import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Report #2 — Farmer Delivery Statement: a per-farmer ledger used to pay
 * farmers fairly. For each farmer: their delivery count, total kilos, the
 * distribution of quality grades they delivered, and the total value of those
 * deliveries (Σ weightKg × pricePerKg).
 *
 * Scoping is applied by the caller: Admin/Staff may request all farmers or a
 * single `farmerId`; a FARMER is force-narrowed to their own id, so this
 * service treats `farmerId` as an already-authorized filter.
 *
 * "Average quality grade" is intentionally NOT a single number: grades are
 * free-form nullable strings (e.g. "AA", "AB", "PB"), so averaging them would
 * be meaningless. Instead each row carries a grade distribution and the most
 * common grade, which is what actually informs a payment decision.
 */

export interface FarmerStatementRow {
  farmerId: string;
  farmerCode: string;
  farmerName: string;
  deliveryCount: number;
  totalKg: number;
  totalValue: number;
  gradeDistribution: { grade: string; count: number }[];
  mostCommonGrade: string | null;
}

export interface FarmerStatement {
  rows: FarmerStatementRow[];
  totals: { deliveryCount: number; totalKg: number; totalValue: number };
  period: { from: string | null; to: string | null } | null;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function getFarmerStatement(
  cooperativeId: string,
  options: { from?: Date; to?: Date; farmerId?: string } = {}
): Promise<FarmerStatement> {
  const where: Prisma.DeliveryWhereInput = {
    cooperativeId,
    ...(options.farmerId && { farmerId: options.farmerId }),
    ...((options.from || options.to) && {
      deliveryDate: { ...(options.from && { gte: options.from }), ...(options.to && { lte: options.to }) },
    }),
  };

  // Prisma groupBy cannot multiply two columns (weightKg × pricePerKg), so we
  // read the raw delivery rows once and fold them per farmer in memory. Volume
  // is bounded by a single cooperative's deliveries in the window.
  const deliveries = await prisma.delivery.findMany({
    where,
    select: {
      farmerId: true,
      weightKg: true,
      pricePerKg: true,
      qualityGrade: true,
      farmer: { select: { farmerCode: true, firstName: true, lastName: true } },
    },
  });

  const byFarmer = new Map<
    string,
    {
      farmerCode: string;
      farmerName: string;
      deliveryCount: number;
      totalKg: number;
      totalValue: number;
      grades: Map<string, number>;
    }
  >();

  for (const d of deliveries) {
    let entry = byFarmer.get(d.farmerId);
    if (!entry) {
      entry = {
        farmerCode: d.farmer.farmerCode,
        farmerName: `${d.farmer.firstName} ${d.farmer.lastName}`,
        deliveryCount: 0,
        totalKg: 0,
        totalValue: 0,
        grades: new Map(),
      };
      byFarmer.set(d.farmerId, entry);
    }

    const kg = toNumber(d.weightKg);
    entry.deliveryCount += 1;
    entry.totalKg += kg;
    // Skip null prices rather than counting them as zero-value, so an
    // unpriced delivery doesn't understate the true owed amount silently.
    if (d.pricePerKg !== null) entry.totalValue += kg * toNumber(d.pricePerKg);

    const grade = d.qualityGrade ?? "Ungraded";
    entry.grades.set(grade, (entry.grades.get(grade) ?? 0) + 1);
  }

  const rows: FarmerStatementRow[] = [...byFarmer.entries()]
    .map(([farmerId, e]) => {
      const gradeDistribution = [...e.grades.entries()]
        .map(([grade, count]) => ({ grade, count }))
        .sort((a, b) => b.count - a.count);
      return {
        farmerId,
        farmerCode: e.farmerCode,
        farmerName: e.farmerName,
        deliveryCount: e.deliveryCount,
        totalKg: round2(e.totalKg),
        totalValue: round2(e.totalValue),
        gradeDistribution,
        mostCommonGrade: gradeDistribution[0]?.grade ?? null,
      };
    })
    .sort((a, b) => b.totalKg - a.totalKg);

  return {
    rows,
    totals: {
      deliveryCount: rows.reduce((s, r) => s + r.deliveryCount, 0),
      totalKg: round2(rows.reduce((s, r) => s + r.totalKg, 0)),
      totalValue: round2(rows.reduce((s, r) => s + r.totalValue, 0)),
    },
    period:
      options.from || options.to
        ? { from: options.from?.toISOString() ?? null, to: options.to?.toISOString() ?? null }
        : null,
  };
}
