import "dotenv/config";
import { z } from "zod";

/**
 * Parses a boolean env var from its string form.
 *
 * NOT `z.coerce.boolean()` — that is `Boolean(value)`, and every non-empty
 * string is truthy, so the literal "false" would come back as `true`. Getting
 * this wrong silently inverted BLOCKCHAIN_ENABLED, which routed every ledger
 * write down the unconfigured real-network path and recorded it as FAILED.
 */
const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["true", "1", "yes", "on"].includes(value.trim().toLowerCase())
  );

// Validate all required environment variables at startup so the app
// fails fast with a clear error instead of misbehaving at runtime.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),
  // Runtime connection for the restricted `app_user` role that row-level
  // security policies actually apply to. DATABASE_URL stays pointed at the
  // migration role, which owns the tables and therefore bypasses RLS. Optional
  // so a checkout that hasn't run scripts/setup-rls-role.sh still boots — it
  // just falls back to the unrestricted connection, with the application-level
  // scoping still in force.
  APP_DATABASE_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  BCRYPT_SALT_ROUNDS: z.coerce.number().min(10).max(15).default(12),

  CORS_ORIGIN: z.string().default("http://localhost:4200"),
  // Public base URL of the frontend — encoded into each batch's QR code so a
  // phone camera scan opens the public verify page (`/verify?token=…`).
  FRONTEND_URL: z.string().url().default("http://localhost:4200"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(10),

  BLOCKCHAIN_NETWORK: z.string().default("hyperledger-fabric-test"),
  BLOCKCHAIN_CHANNEL: z.string().default("coffee-traceability-channel"),
  BLOCKCHAIN_CONTRACT: z.string().default("coffeeBatchContract"),
  BLOCKCHAIN_ENABLED: booleanFromString.default("false"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MAX_UPLOAD_MB: z.coerce.number().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
