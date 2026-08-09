import { z } from "zod";

export const createFarmerSchema = z.object({
  body: z.object({
    cooperativeId: z.string().uuid(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    nationalId: z.string().max(30).optional(),
    phoneNumber: z.string().max(20).optional(),
    farmLocation: z.string().max(200).optional(),
    farmSizeAcres: z.coerce.number().positive().optional(),
    gpsLatitude: z.coerce.number().min(-90).max(90).optional(),
    gpsLongitude: z.coerce.number().min(-180).max(180).optional(),
    // Optional login provisioning, so registering a farmer and handing them a
    // credential is one act at the counter rather than two screens.
    createLogin: z.coerce.boolean().optional(),
    email: z.string().email().toLowerCase().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const listFarmerSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cooperativeId: z.string().uuid().optional(),
    search: z.string().optional(),
  }),
  params: z.object({}).optional(),
});

export const createFarmerAccountSchema = z.object({
  body: z.object({
    email: z.string().email().toLowerCase().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

/** Reset takes no input beyond the farmer — the new password is generated server-side. */
export const resetFarmerPasswordSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});

/**
 * `PATCH /farmers/:id` used to pass the raw body straight to Prisma, which let a
 * caller set `farmerCode`, `userId`, `cooperativeId`, or `isDeleted` — the first
 * two now being login identity, and the third being the tenant boundary itself.
 * Only the fields a cooperative actually corrects are listed here.
 */
export const updateFarmerSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    nationalId: z.string().max(30).optional(),
    phoneNumber: z.string().max(20).optional(),
    farmLocation: z.string().max(200).optional(),
    farmSizeAcres: z.coerce.number().positive().optional(),
    gpsLatitude: z.coerce.number().min(-90).max(90).optional(),
    gpsLongitude: z.coerce.number().min(-180).max(180).optional(),
    isActive: z.coerce.boolean().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().uuid() }),
});
