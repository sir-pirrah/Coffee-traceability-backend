import { PrismaClient, Prisma } from "@prisma/client";
import { env, isProd } from "@/config/env";
import { contextSql, getDbContext, runInTransaction } from "./dbContext";

// Singleton Prisma Client — prevents exhausting the DB connection pool
// with a new client on every hot-reload in development.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: ReturnType<typeof createPrismaClient> | undefined;
}

// Query logging is invaluable in dev and unreadable in a test run, where every
// assertion would be buried in SQL. Errors and warnings still surface anywhere.
const logLevels: ("query" | "error" | "warn")[] =
  isProd || env.NODE_ENV === "test" ? ["error", "warn"] : ["error", "warn", "query"];

function createPrismaClient() {
  const base = new PrismaClient({
    log: logLevels,
    // Prefer the restricted runtime role when one is configured. Row-level
    // security is ignored for superusers and for a table's owner, so connecting
    // as the migration role would leave every policy inert; APP_DATABASE_URL
    // points at `app_user`, which is neither.
    ...(env.APP_DATABASE_URL && { datasources: { db: { url: env.APP_DATABASE_URL } } }),
  });

  return base.$extends({
    name: "rls-session-context",
    query: {
      async $allOperations({ args, query }) {
        const context = getDbContext();

        // Already inside an interactive transaction that applied the settings —
        // run as-is rather than opening a nested one.
        if (context?.inTransaction) return query(args);

        // Pairing set_config with the query in one batched transaction is what
        // makes this safe under a connection pool: both statements are guaranteed
        // to land on the same connection, and `is_local` settings are discarded
        // when it commits. Issuing them separately would let another request's
        // query slip in between on that connection.
        const [, result] = await base.$transaction([
          base.$queryRaw(contextSql(context)),
          query(args) as Prisma.PrismaPromise<unknown>,
        ]);
        return result;
      },
    },
  });
}

export const prisma = global.__prisma ?? createPrismaClient();

if (!isProd) {
  global.__prisma = prisma;
}

/**
 * Runs an interactive transaction with the request's RLS context applied to the
 * connection before the callback body executes.
 *
 * Multi-statement work must use this instead of `prisma.$transaction(...)`
 * directly: the settings are `is_local`, so they have to be established inside
 * the same transaction as the statements they govern. The nested-context flag
 * also stops the extension above from wrapping each individual query in its own
 * transaction, which Postgres would reject.
 */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number }
): Promise<T> {
  const context = getDbContext();
  return prisma.$transaction(
    // The `runInTransaction` scope has to open *before* the set_config, not just
    // around the callback. `tx` here is the extended client, so `tx.$queryRaw`
    // goes through the extension like everything else — and without the flag
    // already set, the extension would helpfully pair it with a nested
    // `base.$transaction`, which the pool serves on a *different* connection.
    // The settings would then apply to a connection nobody is using, this one
    // would stay contextless, and every policy would evaluate against an empty
    // identity: legitimate writes rejected as 42501, legitimate reads returning
    // nothing. Setting the flag first makes the extension pass the statement
    // straight through to `tx`.
    (tx) =>
      runInTransaction(async () => {
        await tx.$queryRaw(contextSql(context));
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
    options
  );
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
