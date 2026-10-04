import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Report #4 — Processing Yield: a quality/efficiency early warning. For each
 * processing record: the batch, method, input vs output weight, yield %, and
 * how long processing took.
 *
 * Input weight assumption: `ProcessingRecord` has no dedicated input-weight
 * column, so the weight that *entered* processing is taken to be the batch's
 * `totalWeightKg` (the accumulated delivered weight). `outputWeightKg` is the
 * measured output; yield% = output / input × 100. If the cooperative ever
 * starts capturing a distinct measured cherry-in weight, switch `inputKg` to
 * read that field instead.
 */

export interface ProcessingYieldRow {
  batchCode: string;
  method: string;
  inputKg: number;
  outputKg: number;
  yieldPct: number | null;
  durationDays: number | null;
  inProgress: boolean;
  startDate: string;
  endDate: string | null;
}

export interface ProcessingYieldReport {
  rows: ProcessingYieldRow[];
  period: { from: string | null; to: string | null } | null;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

const MS_PER_DAY = 86_400_000;

export async function getProcessingYield(
  cooperativeId: string,
  range: { from?: Date; to?: Date } = {}
): Promise<ProcessingYieldReport> {
  const records = await prisma.processingRecord.findMany({
    where: {
      batch: { cooperativeId, isDeleted: false },
      ...((range.from || range.to) && {
        startDate: { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) },
      }),
    },
    select: {
      method: true,
      startDate: true,
      endDate: true,
      outputWeightKg: true,
      batch: { select: { batchCode: true, totalWeightKg: true } },
    },
    orderBy: { startDate: "desc" },
  });

  const rows: ProcessingYieldRow[] = records.map((r) => {
    const inputKg = toNumber(r.batch.totalWeightKg);
    const outputKg = toNumber(r.outputWeightKg);
    const inProgress = r.endDate === null;
    return {
      batchCode: r.batch.batchCode,
      method: r.method,
      inputKg: Math.round(inputKg * 100) / 100,
      outputKg: Math.round(outputKg * 100) / 100,
      // Only report a yield once there's a real output and a real input.
      yieldPct: inputKg > 0 && outputKg > 0 ? Math.round((outputKg / inputKg) * 1000) / 10 : null,
      durationDays: r.endDate ? Math.round((r.endDate.getTime() - r.startDate.getTime()) / MS_PER_DAY) : null,
      inProgress,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate?.toISOString() ?? null,
    };
  });

  return {
    rows,
    period:
      range.from || range.to
        ? { from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null }
        : null,
  };
}
