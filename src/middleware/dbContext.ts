import { NextFunction, Request, Response } from "express";
import { getDbContext, runWithDbContext } from "@/repositories/dbContext";

/**
 * Opens an AsyncLocalStorage scope for the request so every query it makes
 * carries the caller's identity to Postgres, where the row-level security
 * policies read it.
 *
 * Mounted before the routers rather than inside `protect`, because the store has
 * to exist for unauthenticated requests too — those simply carry an empty
 * context, which the policies treat as "matches nothing". That is the desired
 * failure mode: a route that forgets to authenticate returns no rows instead of
 * every tenant's rows.
 *
 * `authenticate` fills in the identity afterwards, since the token hasn't been
 * verified at this point.
 */
export function dbContextScope(_req: Request, _res: Response, next: NextFunction): void {
  runWithDbContext({}, async () => {
    next();
  }).catch(next);
}

/**
 * Marks a router's requests as system context, bypassing row-level security.
 *
 * Only for endpoints that cannot present an identity because they are what
 * establishes one (login, register, refresh) or have no session by design (the
 * public QR scan). Everything else stays policy-governed — mounting this on an
 * ordinary router would silently disable tenant isolation for it.
 */
export function systemContext(_req: Request, _res: Response, next: NextFunction): void {
  const store = getDbContext();
  if (store) store.system = true;
  next();
}
