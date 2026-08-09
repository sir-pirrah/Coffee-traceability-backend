import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

/**
 * Per-request database context, carried to Postgres as `app.*` session settings
 * so the row-level security policies in
 * `prisma/migrations/20260807120000_row_level_security` can see who is asking.
 *
 * Why AsyncLocalStorage rather than passing a scoped client around: the policies
 * only help if *every* query carries context, including the 129 existing call
 * sites that import the shared `prisma` singleton. A store keyed to the async
 * execution context lets the client extension in `prisma.client.ts` pick the
 * values up without a single call site changing shape, so there is no way to
 * "forget" to pass them.
 */
export interface DbContext {
  userId?: string;
  role?: string;
  cooperativeId?: string | null;
  /** The caller's own Farmer profile id, resolved once at authentication. */
  farmerId?: string | null;
  /**
   * Set for the few operations that legitimately have no authenticated user:
   * password verification at login, token refresh, the public QR scan, and the
   * seed script. Policies treat this as unrestricted, so it is deliberately
   * awkward to reach — only `runAsSystem` sets it.
   */
  system?: boolean;
  /**
   * True while inside an interactive transaction that has already applied the
   * settings. Without this the extension would try to open a nested transaction
   * per query on a connection that is already in one.
   */
  inTransaction?: boolean;
}

const storage = new AsyncLocalStorage<DbContext>();

export function getDbContext(): DbContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with the given context visible to every query it makes.
 *
 * `fn` is awaited *inside* the scope rather than having its promise returned
 * straight out of `storage.run`, and that detail is load-bearing. A Prisma
 * promise is lazy: it starts no work until something calls `.then()` on it. With
 * `storage.run(context, fn)`, a caller writing the natural
 * `runWithDbContext(ctx, () => prisma.user.findMany())` builds the promise inside
 * the scope but subscribes to it at the `await` *outside*, so the query's async
 * resource is created with no store attached and the context silently arrives
 * empty. Awaiting here means the subscription happens within the scope no matter
 * which shape the caller uses.
 */
export function runWithDbContext<T>(context: DbContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, async () => await fn());
}

/**
 * Runs `fn` with policies bypassed.
 *
 * Reserved for work that cannot present a user because it is what establishes
 * one, or because there is genuinely no session: `/auth/login` reading a user by
 * email to check their password, `/auth/refresh`, the public `/batches/verify`
 * scan, and `prisma:seed`. Keep the wrapped region as small as the operation
 * itself — it is the one place tenant isolation does not apply.
 */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  return runWithDbContext({ ...parent, system: true, inTransaction: false }, fn);
}

/** Marks the current context as already inside a settings-applied transaction. */
export function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore() ?? {};
  return runWithDbContext({ ...parent, inTransaction: true }, fn);
}

/**
 * The `set_config` calls that put the current context on the connection.
 *
 * `is_local => true` is the important argument: it scopes each value to the
 * surrounding transaction, so it is discarded at commit. A plain `SET` would
 * persist on the pooled connection and the next request to borrow it would
 * inherit the previous caller's identity — which is a tenant-isolation bug that
 * looks like a caching glitch.
 */
export function contextSql(context: DbContext | undefined): Prisma.Sql {
  const ctx = context ?? {};
  return Prisma.sql`SELECT
    set_config('app.user_id', ${ctx.userId ?? ""}, true),
    set_config('app.role', ${ctx.role ?? ""}, true),
    set_config('app.cooperative_id', ${ctx.cooperativeId ?? ""}, true),
    set_config('app.farmer_id', ${ctx.farmerId ?? ""}, true),
    set_config('app.system', ${ctx.system ? "on" : ""}, true)`;
}
