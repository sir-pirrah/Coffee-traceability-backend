import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Aggregations behind the cooperative dashboard.
 *
 * The dashboard needs five different shapes of data (KPI totals with a
 * period-over-period trend, a monthly movement series, a grade split, an
 * activity feed, and ledger health). Fetching those as five round-trips from
 * the browser made the first paint wait on the slowest one and gave every card
 * its own failure mode, so they are computed together here and served as one
 * payload.
 *
 * Everything is filtered by `cooperativeId`; the route asserts the caller owns
 * that cooperative before calling in, so no query here is reachable across
 * cooperative boundaries.
 */

export interface DashboardKpis {
  totalFarmers: number;
  totalBatches: number;
  receivedKg: number;
  inStorageKg: number;
  soldKg: number;
  /** Percent change against the immediately preceding window, or null when there is no baseline. */
  trends: {
    farmers: number | null;
    batches: number | null;
    received: number | null;
    sold: number | null;
  };
}

export interface MovementPoint {
  /** `YYYY-MM` — the frontend formats the label so it follows the user's locale. */
  period: string;
  receivedKg: number;
  processedKg: number;
  soldKg: number;
}

export interface GradeSlice {
  grade: string;
  weightKg: number;
  percentage: number;
}

export interface ActivityItem {
  id: string;
  type: "DELIVERY" | "BATCH" | "PROCESSING" | "WAREHOUSE" | "SALE";
  title: string;
  description: string;
  at: string;
}

export interface ChainStatus {
  totalEvents: number;
  confirmed: number;
  pending: number;
  failed: number;
  lastBlock: { hash: string; eventType: string; batchCode: string; submittedAt: string } | null;
}

export interface CooperativeDashboard {
  kpis: DashboardKpis;
  movement: MovementPoint[];
  grades: GradeSlice[];
  activities: ActivityItem[];
  chain: ChainStatus;
}

const TREND_WINDOW_DAYS = 30;

/**
 * Percent change from `previous` to `current`. Returns null rather than a
 * fabricated +100% when there is no prior activity to compare against — the UI
 * hides the trend chip in that case instead of implying growth we can't show.
 */
function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100) / 100;
}

/** Monthly received / processed / sold weights, with empty months preserved. */
async function getMovementSeries(cooperativeId: string, months: number): Promise<MovementPoint[]> {
  // A generate_series spine keeps quiet months in the result, so the chart shows
  // a genuine dip rather than silently compressing the x-axis.
  const rows = await prisma.$queryRaw<
    { period: string; receivedKg: number; processedKg: number; soldKg: number }[]
  >`
    WITH spine AS (
      SELECT generate_series(
        date_trunc('month', now()) - (${months - 1}::int * interval '1 month'),
        date_trunc('month', now()),
        interval '1 month'
      ) AS bucket
    )
    SELECT
      to_char(spine.bucket, 'YYYY-MM') AS "period",
      COALESCE((
        SELECT SUM(d.weight_kg) FROM deliveries d
        WHERE d.cooperative_id = ${cooperativeId}::uuid
          AND d.delivery_date >= spine.bucket
          AND d.delivery_date < spine.bucket + interval '1 month'
      ), 0)::float AS "receivedKg",
      COALESCE((
        SELECT SUM(COALESCE(p.output_weight_kg, b.total_weight_kg)) FROM processing_records p
        JOIN coffee_batches b ON b.id = p.batch_id
        WHERE b.cooperative_id = ${cooperativeId}::uuid AND b.is_deleted = false
          AND p.start_date >= spine.bucket
          AND p.start_date < spine.bucket + interval '1 month'
      ), 0)::float AS "processedKg",
      COALESCE((
        SELECT SUM(b.total_weight_kg) FROM ownership_transfers t
        JOIN coffee_batches b ON b.id = t.batch_id
        WHERE b.cooperative_id = ${cooperativeId}::uuid AND b.is_deleted = false
          AND t.status = 'CONFIRMED'
          AND t.transferred_at >= spine.bucket
          AND t.transferred_at < spine.bucket + interval '1 month'
      ), 0)::float AS "soldKg"
    FROM spine
    ORDER BY spine.bucket
  `;

  return rows.map((row) => ({
    period: row.period,
    receivedKg: toNumber(row.receivedKg),
    processedKg: toNumber(row.processedKg),
    soldKg: toNumber(row.soldKg),
  }));
}

/** Delivered weight per quality grade, largest first. */
async function getGradeSplit(cooperativeId: string): Promise<GradeSlice[]> {
  const rows = await prisma.delivery.groupBy({
    by: ["qualityGrade"],
    where: { cooperativeId },
    _sum: { weightKg: true },
  });

  const slices = rows
    .map((row) => ({ grade: row.qualityGrade ?? "Ungraded", weightKg: toNumber(row._sum.weightKg) }))
    .filter((slice) => slice.weightKg > 0)
    .sort((a, b) => b.weightKg - a.weightKg);

  const total = slices.reduce((sum, slice) => sum + slice.weightKg, 0);
  return slices.map((slice) => ({
    ...slice,
    percentage: total > 0 ? Math.round((slice.weightKg / total) * 1000) / 10 : 0,
  }));
}

/**
 * A merged, newest-first feed of the five things that actually happen to
 * coffee. Each source is capped before merging so one busy stream (deliveries,
 * typically) can't crowd the others out of the window.
 */
async function getActivityFeed(cooperativeId: string, limit: number): Promise<ActivityItem[]> {
  const batchScope = { batch: { cooperativeId, isDeleted: false } };

  const [deliveries, batches, processing, storage, sales] = await Promise.all([
    prisma.delivery.findMany({
      where: { cooperativeId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        deliveryCode: true,
        weightKg: true,
        qualityGrade: true,
        createdAt: true,
        farmer: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.coffeeBatch.findMany({
      where: { cooperativeId, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, batchCode: true, totalWeightKg: true, originRegion: true, createdAt: true },
    }),
    prisma.processingRecord.findMany({
      where: batchScope,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, method: true, createdAt: true, batch: { select: { batchCode: true } } },
    }),
    prisma.warehouseInventory.findMany({
      where: batchScope,
      orderBy: { storedAt: "desc" },
      take: limit,
      select: {
        id: true,
        weightKg: true,
        storedAt: true,
        batch: { select: { batchCode: true } },
        warehouse: { select: { name: true } },
      },
    }),
    prisma.ownershipTransfer.findMany({
      where: { ...batchScope, status: "CONFIRMED" },
      orderBy: { transferredAt: "desc" },
      take: limit,
      select: {
        id: true,
        transferredAt: true,
        batch: { select: { batchCode: true, totalWeightKg: true } },
        buyer: { select: { companyName: true } },
      },
    }),
  ]);

  const items: ActivityItem[] = [
    ...deliveries.map((d) => ({
      id: `delivery-${d.id}`,
      type: "DELIVERY" as const,
      title: "New delivery recorded",
      description: `${d.farmer.firstName} ${d.farmer.lastName} delivered ${toNumber(d.weightKg)} kg${
        d.qualityGrade ? ` (Grade ${d.qualityGrade})` : ""
      }`,
      at: d.createdAt.toISOString(),
    })),
    ...batches.map((b) => ({
      id: `batch-${b.id}`,
      type: "BATCH" as const,
      title: `Batch ${b.batchCode} created`,
      description: `${toNumber(b.totalWeightKg)} kg${b.originRegion ? ` from ${b.originRegion}` : ""}`,
      at: b.createdAt.toISOString(),
    })),
    ...processing.map((p) => ({
      id: `processing-${p.id}`,
      type: "PROCESSING" as const,
      title: "Processing started",
      description: `${p.batch.batchCode} — ${p.method.toLowerCase().replace("_", " ")} method`,
      at: p.createdAt.toISOString(),
    })),
    ...storage.map((s) => ({
      id: `storage-${s.id}`,
      type: "WAREHOUSE" as const,
      title: "Stored in warehouse",
      description: `${s.batch.batchCode} — ${toNumber(s.weightKg)} kg at ${s.warehouse.name}`,
      at: s.storedAt.toISOString(),
    })),
    ...sales.map((t) => ({
      id: `sale-${t.id}`,
      type: "SALE" as const,
      title: "Ownership transferred",
      description: `${t.batch.batchCode} — ${toNumber(t.batch.totalWeightKg)} kg to ${
        t.buyer?.companyName ?? "a buyer"
      }`,
      at: t.transferredAt.toISOString(),
    })),
  ];

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Ledger health for this cooperative's batches, plus the most recent block. */
async function getChainStatus(cooperativeId: string): Promise<ChainStatus> {
  const scope = { batch: { cooperativeId, isDeleted: false } };

  const [byStatus, lastBlock] = await Promise.all([
    prisma.blockchainTransaction.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    prisma.blockchainTransaction.findFirst({
      where: scope,
      orderBy: { submittedAt: "desc" },
      select: {
        blockHash: true,
        eventType: true,
        submittedAt: true,
        batch: { select: { batchCode: true } },
      },
    }),
  ]);

  const countOf = (status: string) => byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    totalEvents: byStatus.reduce((sum, row) => sum + row._count._all, 0),
    confirmed: countOf("CONFIRMED"),
    pending: countOf("PENDING"),
    failed: countOf("FAILED"),
    lastBlock: lastBlock
      ? {
          hash: lastBlock.blockHash,
          eventType: lastBlock.eventType,
          batchCode: lastBlock.batch.batchCode,
          submittedAt: lastBlock.submittedAt.toISOString(),
        }
      : null,
  };
}

export async function getCooperativeDashboard(
  cooperativeId: string,
  options: { months?: number; activityLimit?: number } = {}
): Promise<CooperativeDashboard> {
  const months = Math.min(Math.max(options.months ?? 6, 1), 24);
  const activityLimit = Math.min(Math.max(options.activityLimit ?? 8, 1), 50);

  const windowStart = new Date(Date.now() - TREND_WINDOW_DAYS * 86_400_000);
  const baselineStart = new Date(Date.now() - 2 * TREND_WINDOW_DAYS * 86_400_000);

  const [
    totalFarmers,
    totalBatches,
    receivedAgg,
    storageAgg,
    soldAgg,
    farmersThisWindow,
    farmersLastWindow,
    batchesThisWindow,
    batchesLastWindow,
    receivedThisWindow,
    receivedLastWindow,
    soldThisWindow,
    soldLastWindow,
    movement,
    grades,
    activities,
    chain,
  ] = await Promise.all([
    prisma.farmer.count({ where: { cooperativeId, isDeleted: false } }),
    prisma.coffeeBatch.count({ where: { cooperativeId, isDeleted: false } }),
    prisma.delivery.aggregate({ where: { cooperativeId }, _sum: { weightKg: true } }),
    // Only inventory that hasn't been removed is actually "in storage".
    prisma.warehouseInventory.aggregate({
      where: { removedAt: null, batch: { cooperativeId, isDeleted: false } },
      _sum: { weightKg: true },
    }),
    prisma.coffeeBatch.aggregate({
      where: { cooperativeId, isDeleted: false, status: { in: ["SOLD", "EXPORTED"] } },
      _sum: { totalWeightKg: true },
    }),
    prisma.farmer.count({ where: { cooperativeId, isDeleted: false, createdAt: { gte: windowStart } } }),
    prisma.farmer.count({
      where: { cooperativeId, isDeleted: false, createdAt: { gte: baselineStart, lt: windowStart } },
    }),
    prisma.coffeeBatch.count({ where: { cooperativeId, isDeleted: false, createdAt: { gte: windowStart } } }),
    prisma.coffeeBatch.count({
      where: { cooperativeId, isDeleted: false, createdAt: { gte: baselineStart, lt: windowStart } },
    }),
    prisma.delivery.aggregate({
      where: { cooperativeId, deliveryDate: { gte: windowStart } },
      _sum: { weightKg: true },
    }),
    prisma.delivery.aggregate({
      where: { cooperativeId, deliveryDate: { gte: baselineStart, lt: windowStart } },
      _sum: { weightKg: true },
    }),
    prisma.ownershipTransfer.count({
      where: { status: "CONFIRMED", transferredAt: { gte: windowStart }, batch: { cooperativeId, isDeleted: false } },
    }),
    prisma.ownershipTransfer.count({
      where: {
        status: "CONFIRMED",
        transferredAt: { gte: baselineStart, lt: windowStart },
        batch: { cooperativeId, isDeleted: false },
      },
    }),
    getMovementSeries(cooperativeId, months),
    getGradeSplit(cooperativeId),
    getActivityFeed(cooperativeId, activityLimit),
    getChainStatus(cooperativeId),
  ]);

  return {
    kpis: {
      totalFarmers,
      totalBatches,
      receivedKg: toNumber(receivedAgg._sum.weightKg),
      inStorageKg: toNumber(storageAgg._sum.weightKg),
      soldKg: toNumber(soldAgg._sum.totalWeightKg),
      trends: {
        farmers: percentChange(farmersThisWindow, farmersLastWindow),
        batches: percentChange(batchesThisWindow, batchesLastWindow),
        received: percentChange(toNumber(receivedThisWindow._sum.weightKg), toNumber(receivedLastWindow._sum.weightKg)),
        sold: percentChange(soldThisWindow, soldLastWindow),
      },
    },
    movement,
    grades,
    activities,
    chain,
  };
}
