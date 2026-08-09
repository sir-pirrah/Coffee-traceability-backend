import { z } from "zod";

export const createCooperativeSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(200),
    registrationNo: z.string().max(50).optional(),
    county: z.string().min(2).max(100),
    subCounty: z.string().max(100).optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().max(20).optional(),
    address: z.string().max(300).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateCooperativeSchema = z.object({
  body: createCooperativeSchema.shape.body.partial(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

export const listCooperativeSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    county: z.string().optional(),
    search: z.string().optional(),
  }),
  params: z.object({}).optional(),
});
