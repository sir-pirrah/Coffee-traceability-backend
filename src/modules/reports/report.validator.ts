import { z } from "zod";

// Every coop-keyed report carries :cooperativeId in the path. The `validate`
// middleware re-parses req.params and writes the result back, and Zod strips
// keys a schema doesn't declare — so the path param MUST be declared here or it
// would be erased before the controller's assertOwnership can read it. Declaring
// it also validates the id shape (a non-UUID 400s rather than reaching Prisma).
const cooperativeParams = z.object({
  cooperativeId: z.string().uuid(),
});

// Shared date-range query used by the period-filtered reports (Operations
// Summary, Processing Yield, Sales & Transfer Ledger). Mirrors the coercion
// style of delivery.validator.ts so query strings become real Dates.
export const dateRangeQuerySchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
  params: cooperativeParams,
});

// Farmer Delivery Statement: a date range plus an optional single-farmer
// filter. A FARMER caller is force-narrowed to their own id server-side, so
// this param only takes effect for Admin/Staff.
export const farmerStatementQuerySchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    farmerId: z.string().uuid().optional(),
  }),
  params: cooperativeParams,
});

// Operations Summary: same optional date range.
export const summaryQuerySchema = dateRangeQuerySchema;

export type DateRange = z.infer<typeof dateRangeQuerySchema>["query"];
export type FarmerStatementQuery = z.infer<typeof farmerStatementQuerySchema>["query"];
