import { prisma } from "@/repositories/prisma.client";
import { Prisma } from "@prisma/client";

/**
 * Report #5 — Warehouse Inventory Snapshot: what is in storage right now and
 * for how long. Per warehouse: batches stored, total weight, capacity used %,
 * and per-batch days-in-storage.
 *
 * "Snapshot" means active inventory only — rows where `removedAt` is null.
 * A removed row is history, not current stock.
 */

export interface WarehouseInventoryItem {
  batchCode: string;
  weightKg: number;
  daysInStorage: number;
  storedAt: string;
}

export interface WarehouseInventoryRow {
  warehouseId: string;
  warehouseName: string;
  location: string | null;
  batchesStored: number;
  storedWeightKg: number;
  capacityKg: number | null;
  /** null when the warehouse has no recorded capacity. */
  capacityUsedPct: number | null;
  items: WarehouseInventoryItem[];
}

export interface WarehouseInventorySnapshot {
  rows: WarehouseInventoryRow[];
  generatedAt: string;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

const MS_PER_DAY = 86_400_000;

export async function getWarehouseInventorySnapshot(cooperativeId: string): Promise<WarehouseInventorySnapshot> {
  const now = Date.now();

  const warehouses = await prisma.warehouse.findMany({
    where: { cooperativeId },
    select: {
      id: true,
      name: true,
      location: true,
      capacityKg: true,
      inventory: {
        where: { removedAt: null },
        select: { weightKg: true, storedAt: true, batch: { select: { batchCode: true } } },
        orderBy: { storedAt: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  const rows: WarehouseInventoryRow[] = warehouses.map((w) => {
    const items = w.inventory.map((inv) => ({
      batchCode: inv.batch.batchCode,
      weightKg: Math.round(toNumber(inv.weightKg) * 100) / 100,
      daysInStorage: Math.max(0, Math.floor((now - inv.storedAt.getTime()) / MS_PER_DAY)),
      storedAt: inv.storedAt.toISOString(),
    }));

    const storedWeightKg = Math.round(items.reduce((s, i) => s + i.weightKg, 0) * 100) / 100;
    const capacityKg = w.capacityKg !== null ? toNumber(w.capacityKg) : null;

    return {
      warehouseId: w.id,
      warehouseName: w.name,
      location: w.location,
      batchesStored: items.length,
      storedWeightKg,
      capacityKg,
      capacityUsedPct:
        capacityKg && capacityKg > 0 ? Math.round((storedWeightKg / capacityKg) * 1000) / 10 : null,
      items,
    };
  });

  return { rows, generatedAt: new Date(now).toISOString() };
}
