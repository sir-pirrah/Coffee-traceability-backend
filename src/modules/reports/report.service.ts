import { prisma } from "@/repositories/prisma.client";

export interface BatchMovement {
  batchCode: string;
  status: string;
  totalWeightKg: number;
  originRegion?: string | null;
  cooperative: { name: string; county: string };
  timeline: {
    stage: string;
    date: string;
    location?: string;
    notes?: string;
  }[];
}

/**
 * Traces a coffee batch's full journey from delivery → processing →
 * warehouse → ownership transfer, reconstructing the movement timeline
 * required by Chapter 5's "Reports of Coffee Movement" objective.
 */
export async function getBatchMovement(batchId: string): Promise<BatchMovement> {
  const batch = await prisma.coffeeBatch.findUnique({
    where: { id: batchId },
    include: {
      cooperative: { select: { name: true, county: true } },
      deliveries: {
        select: { deliveryDate: true, weightKg: true, farmer: { select: { firstName: true, lastName: true } } },
        orderBy: { deliveryDate: "asc" },
      },
      processingRecords: {
        select: { startDate: true, endDate: true, method: true },
        orderBy: { startDate: "asc" },
      },
      warehouseInventory: {
        select: { storedAt: true, removedAt: true, warehouse: { select: { name: true, location: true } } },
        orderBy: { storedAt: "asc" },
      },
      ownershipTransfers: {
        where: { status: "CONFIRMED" },
        select: { createdAt: true, buyer: { select: { companyName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!batch) {
    throw new Error("Batch not found");
  }

  const timeline: BatchMovement["timeline"] = [];

  // 1. Deliveries (harvest/origin stage)
  if (batch.deliveries.length > 0) {
    const firstDelivery = batch.deliveries[0];
    timeline.push({
      stage: "Harvest & Delivery",
      date: firstDelivery.deliveryDate.toISOString(),
      location: batch.originRegion || undefined,
      notes: `${batch.deliveries.length} delivery(ies), ${batch.deliveries.reduce((sum, d) => sum + Number(d.weightKg), 0)} kg total`,
    });
  }

  // 2. Batch registration
  timeline.push({
    stage: "Batch Registered",
    date: batch.createdAt.toISOString(),
    location: batch.cooperative.name,
    notes: `Batch ${batch.batchCode} created`,
  });

  // 3. Processing
  for (const record of batch.processingRecords) {
    timeline.push({
      stage: "Processing",
      date: record.startDate.toISOString(),
      location: batch.cooperative.name,
      notes: `Method: ${record.method}${record.endDate ? `, completed ${record.endDate.toISOString().split("T")[0]}` : ""}`,
    });
  }

  // 4. Warehouse storage
  for (const inv of batch.warehouseInventory) {
    timeline.push({
      stage: "Warehouse Storage",
      date: inv.storedAt.toISOString(),
      location: inv.warehouse.location || inv.warehouse.name,
      notes: inv.removedAt ? `Removed ${inv.removedAt.toISOString().split("T")[0]}` : "Currently stored",
    });
  }

  // 5. Ownership transfers (sales)
  for (const transfer of batch.ownershipTransfers) {
    timeline.push({
      stage: "Sold",
      date: transfer.createdAt.toISOString(),
      notes: transfer.buyer ? `Buyer: ${transfer.buyer.companyName}` : undefined,
    });
  }

  return {
    batchCode: batch.batchCode,
    status: batch.status,
    totalWeightKg: Number(batch.totalWeightKg),
    originRegion: batch.originRegion,
    cooperative: batch.cooperative,
    timeline,
  };
}
