import { prisma, withTransaction } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import { nextEntityCode } from "@/utils/entityCode";
import { recordBlockchainEvent } from "@/blockchain/blockchain.service";
import { notificationService } from "@/modules/notifications/notification.service";
import { Prisma } from "@prisma/client";

export async function createDelivery(data: {
  farmerId: string;
  cooperativeId: string;
  weightKg: number;
  qualityGrade?: string;
  moistureLevel?: number;
  pricePerKg?: number;
  notes?: string;
  actorId?: string;
}) {
  const farmer = await prisma.farmer.findFirst({
    where: { id: data.farmerId, cooperativeId: data.cooperativeId, isDeleted: false },
  });
  if (!farmer) throw ApiError.badRequest("Farmer does not belong to this cooperative or does not exist");

  const deliveryCode = await nextEntityCode("delivery", "DEL", 6);

  const delivery = await prisma.delivery.create({
    data: {
      deliveryCode,
      farmer: { connect: { id: data.farmerId } },
      cooperative: { connect: { id: data.cooperativeId } },
      weightKg: data.weightKg,
      qualityGrade: data.qualityGrade,
      moistureLevel: data.moistureLevel,
      pricePerKg: data.pricePerKg,
      notes: data.notes,
    },
  });

  // Intake is the event the cooperative's staff act on, and the one the farmer
  // wants confirmation of. Emitted after the write commits; never throws.
  await notificationService.notifyDeliveryCreated({
    cooperativeId: data.cooperativeId,
    deliveryCode: delivery.deliveryCode,
    farmerName: `${farmer.firstName} ${farmer.lastName}`,
    farmerUserId: farmer.userId,
    weightKg: Number(delivery.weightKg),
    actorId: data.actorId,
  });

  return delivery;
}

export async function listDeliveries(opts: {
  page: number;
  limit: number;
  farmerId?: string;
  cooperativeId?: string;
  batchId?: string;
  from?: Date;
  to?: Date;
}) {
  const where: Prisma.DeliveryWhereInput = {
    ...(opts.farmerId && { farmerId: opts.farmerId }),
    ...(opts.cooperativeId && { cooperativeId: opts.cooperativeId }),
    ...(opts.batchId && { batchId: opts.batchId }),
    ...((opts.from || opts.to) && {
      deliveryDate: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) },
    }),
  };

  const [items, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      orderBy: { deliveryDate: "desc" },
      include: { farmer: { select: { firstName: true, lastName: true, farmerCode: true } } },
    }),
    prisma.delivery.count({ where }),
  ]);

  return { items, total };
}

export async function getDeliveryById(id: string) {
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { farmer: true, cooperative: true },
  });
  if (!delivery) throw ApiError.notFound("Delivery not found");
  return delivery;
}

// Attaches one or more un-batched deliveries to a coffee batch and rolls
// up the batch's total weight — wrapped in a transaction for consistency.
export async function assignDeliveriesToBatch(batchId: string, deliveryIds: string[], actorId?: string) {
  const { batch, graded } = await withTransaction(async (tx: Prisma.TransactionClient) => {
    const found = await tx.coffeeBatch.findUnique({ where: { id: batchId } });
    if (!found) throw ApiError.notFound("Coffee batch not found");

    const deliveries = await tx.delivery.findMany({
      where: { id: { in: deliveryIds }, batchId: null, cooperativeId: found.cooperativeId },
    });
    if (deliveries.length !== deliveryIds.length) {
      throw ApiError.badRequest("One or more deliveries are invalid, already batched, or from a different cooperative");
    }

    await tx.delivery.updateMany({ where: { id: { in: deliveryIds } }, data: { batchId } });

    const addedWeight = deliveries.reduce((sum: number, d: (typeof deliveries)[number]) => sum + Number(d.weightKg), 0);

    const updated = await tx.coffeeBatch.update({
      where: { id: batchId },
      data: { totalWeightKg: { increment: addedWeight } },
    });

    return {
      batch: updated,
      graded: deliveries
        .filter((d: (typeof deliveries)[number]) => !!d.qualityGrade)
        .map((d: (typeof deliveries)[number]) => ({
          deliveryCode: d.deliveryCode,
          qualityGrade: d.qualityGrade,
          moistureLevel: d.moistureLevel != null ? Number(d.moistureLevel) : null,
        })),
    };
  });

  // Quality grades enter the batch's permanent record when the graded
  // deliveries are attached — the proposal requires this on the ledger.
  if (graded.length > 0) {
    await recordBlockchainEvent(batchId, "QUALITY_GRADED", {
      deliveryCount: graded.length,
      grades: graded,
      recordedAt: new Date().toISOString(),
    });
  }

  await notificationService.notifyDeliveriesAssigned({
    cooperativeId: batch.cooperativeId,
    batchCode: batch.batchCode,
    deliveryCount: deliveryIds.length,
    actorId,
  });

  return batch;
}
