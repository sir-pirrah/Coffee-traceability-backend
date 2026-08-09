/**
 * Runs before any test module is imported.
 *
 * `@/config/env` validates process.env at import time and calls
 * `process.exit(1)` when something is missing, which would kill the whole
 * Vitest run with no useful output. Filling in safe test defaults here keeps
 * the suite runnable on a bare checkout and in CI.
 *
 * A real DATABASE_URL from `.env` still wins — DB-backed suites need it, and
 * they skip themselves when it is absent (see `dbAvailable` in db.ts).
 */
import "dotenv/config";

process.env.NODE_ENV = "test";

const defaults: Record<string, string> = {
  // 64 hex chars — comfortably over the 32-char minimum the schema enforces.
  JWT_ACCESS_SECRET: "test_access_secret_0123456789abcdef0123456789abcdef0123456789ab",
  JWT_REFRESH_SECRET: "test_refresh_secret_fedcba9876543210fedcba9876543210fedcba9876",
  DATABASE_URL: "postgresql://localhost:5432/coffee_traceability_test?schema=public",
  BLOCKCHAIN_ENABLED: "false",
  // "silent" is not in the env schema's enum — "fatal" is the quietest valid level.
  LOG_LEVEL: "fatal",
  // Rate limiters are per-process; the default 300/15min would start rejecting
  // requests partway through a suite that exercises many endpoints.
  RATE_LIMIT_MAX: "100000",
  AUTH_RATE_LIMIT_MAX: "100000",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

// Probe Postgres once, before any suite is collected, and publish the result so
// `describeIfDb` can decide synchronously whether to skip DB-backed suites.
const { PrismaClient } = await import("@prisma/client");
const probe = new PrismaClient({ log: [] });
try {
  await probe.$queryRaw`SELECT 1`;
  process.env.TEST_DB_READY = "1";
} catch {
  process.env.TEST_DB_READY = "0";
  // eslint-disable-next-line no-console
  console.warn("⚠  No database reachable — DB-backed suites will be skipped.");
} finally {
  await probe.$disconnect();
}
