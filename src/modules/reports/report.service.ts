import { prisma } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import { verifyChain } from "@/blockchain/blockchain.service";

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
        // Date the sale from when custody actually changed, not when the
        // transfer row was drafted — the two differ whenever a transfer sits
        // PENDING for a while, which would otherwise place the sale on the
        // wrong day of the movement report.
        select: { transferredAt: true, buyer: { select: { companyName: true } } },
        orderBy: { transferredAt: "asc" },
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
      date: transfer.transferredAt.toISOString(),
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

/**
 * Report #3 — Batch Traceability Sheet: a consolidated, audit-facing view of a
 * batch's full journey. Viewer is internal (Admin/Staff/Auditor), so unlike the
 * public QR view it MAY carry farmer names — but still keeps out national IDs,
 * phone numbers, GPS coordinates and prices (Kenya DPA 2019 posture; sale
 * financials live on the Sales Ledger, not here).
 *
 * Combines the batch identity, contributing deliveries + farmers, processing
 * steps, warehouse history, sale status, and the tamper-evident blockchain
 * confirmation (`verifyChain`).
 */

export interface TraceabilityDelivery {
  farmerName: string;
  weightKg: number;
  qualityGrade: string | null;
  deliveryDate: string;
}

export interface TraceabilityProcessing {
  method: string;
  startDate: string;
  endDate: string | null;
  outputWeightKg: number | null;
}

export interface TraceabilityWarehouse {
  warehouseName: string;
  location: string | null;
  storedAt: string;
  removedAt: string | null;
}

export interface TraceabilitySale {
  buyerName: string | null;
  country: string | null;
  status: string;
  transferredAt: string;
}

export interface BatchTraceabilitySheet {
  batchCode: string;
  status: string;
  originRegion: string | null;
  harvestSeason: string | null;
  totalWeightKg: number;
  cooperative: { name: string; county: string };
  deliveries: TraceabilityDelivery[];
  processing: TraceabilityProcessing[];
  warehouseHistory: TraceabilityWarehouse[];
  sales: TraceabilitySale[];
  blockchain: { chainValid: boolean; brokenAt?: string; confirmedEvents: number };
  generatedAt: string;
}

export async function getBatchTraceabilitySheet(batchId: string): Promise<BatchTraceabilitySheet> {
  const batch = await prisma.coffeeBatch.findFirst({
    where: { id: batchId, isDeleted: false },
    select: {
      batchCode: true,
      status: true,
      originRegion: true,
      harvestSeason: true,
      totalWeightKg: true,
      cooperative: { select: { name: true, county: true } },
      deliveries: {
        select: {
          weightKg: true,
          qualityGrade: true,
          deliveryDate: true,
          farmer: { select: { firstName: true, lastName: true } },
        },
        orderBy: { deliveryDate: "asc" },
      },
      processingRecords: {
        select: { method: true, startDate: true, endDate: true, outputWeightKg: true },
        orderBy: { startDate: "asc" },
      },
      warehouseInventory: {
        select: { storedAt: true, removedAt: true, warehouse: { select: { name: true, location: true } } },
        orderBy: { storedAt: "asc" },
      },
      ownershipTransfers: {
        select: { status: true, transferredAt: true, buyer: { select: { companyName: true, country: true } } },
        orderBy: { transferredAt: "asc" },
      },
      blockchainTxs: { where: { status: "CONFIRMED" }, select: { id: true } },
    },
  });

  if (!batch) throw ApiError.notFound("Coffee batch not found");

  const chain = await verifyChain(batchId);

  return {
    batchCode: batch.batchCode,
    status: batch.status,
    originRegion: batch.originRegion,
    harvestSeason: batch.harvestSeason,
    totalWeightKg: Number(batch.totalWeightKg),
    cooperative: batch.cooperative,
    deliveries: batch.deliveries.map((d) => ({
      farmerName: `${d.farmer.firstName} ${d.farmer.lastName}`,
      weightKg: Math.round(Number(d.weightKg) * 100) / 100,
      qualityGrade: d.qualityGrade,
      deliveryDate: d.deliveryDate.toISOString(),
    })),
    processing: batch.processingRecords.map((p) => ({
      method: p.method,
      startDate: p.startDate.toISOString(),
      endDate: p.endDate?.toISOString() ?? null,
      outputWeightKg: p.outputWeightKg !== null ? Math.round(Number(p.outputWeightKg) * 100) / 100 : null,
    })),
    warehouseHistory: batch.warehouseInventory.map((w) => ({
      warehouseName: w.warehouse.name,
      location: w.warehouse.location,
      storedAt: w.storedAt.toISOString(),
      removedAt: w.removedAt?.toISOString() ?? null,
    })),
    sales: batch.ownershipTransfers.map((t) => ({
      buyerName: t.buyer?.companyName ?? null,
      country: t.buyer?.country ?? null,
      status: t.status,
      transferredAt: t.transferredAt.toISOString(),
    })),
    blockchain: {
      chainValid: chain.valid,
      ...(chain.brokenAt && { brokenAt: chain.brokenAt }),
      confirmedEvents: batch.blockchainTxs.length,
    },
    generatedAt: new Date().toISOString(),
  };
}
