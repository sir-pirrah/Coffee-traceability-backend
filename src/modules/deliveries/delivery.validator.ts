import { z } from "zod";

export const createDeliverySchema = z.object({
  body: z.object({
    farmerId: z.string().uuid(),
    cooperativeId: z.string().uuid(),
    weightKg: z.coerce.number().positive().max(100_000),
    qualityGrade: z.string().max(10).optional(),
    moistureLevel: z.coerce.number().min(0).max(100).optional(),
    pricePerKg: z.coerce.number().positive().optional(),
    notes: z.string().max(500).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const listDeliverySchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    farmerId: z.string().uuid().optional(),
    cooperativeId: z.string().uuid().optional(),
    batchId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
  params: z.object({}).optional(),
});
