import { z } from "zod";

export const createBatchSchema = z.object({
  body: z.object({
    cooperativeId: z.string().uuid(),
    originRegion: z.string().max(100).optional(),
    harvestSeason: z.string().max(20).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const listBatchSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cooperativeId: z.string().uuid().optional(),
    status: z
      .enum(["REGISTERED", "IN_PROCESSING", "PROCESSED", "IN_STORAGE", "IN_TRANSIT", "SOLD", "EXPORTED", "REJECTED"])
      .optional(),
  }),
  params: z.object({}).optional(),
});

export const updateStatusSchema = z.object({
  body: z.object({
    status: z.enum(["IN_PROCESSING", "PROCESSED", "IN_STORAGE", "IN_TRANSIT", "SOLD", "EXPORTED", "REJECTED"]),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});
