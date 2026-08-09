import { NextFunction, Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";

/**
 * Blocks every protected route for a user still holding an administrator-issued
 * temporary password, until they have set one of their own.
 *
 * The rule has to live on the server, not in a route guard. A farmer's first
 * password was read off someone else's screen and written on a slip of paper —
 * anyone who saw that slip can present it. A frontend redirect would keep them
 * out of the *pages* while leaving `GET /deliveries` answering their token
 * directly, which is where the actual records are.
 *
 * The allow-list is exactly what someone in that state legitimately needs: the
 * endpoint that clears the flag, the one that ends the session, and the identity
 * read the shell makes on load so it can render their name on the form.
 */
const ALLOWED_WHILE_PENDING: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /\/auth\/change-password$/ },
  { method: "POST", path: /\/auth\/logout$/ },
  { method: "GET", path: /\/users\/me$/ },
];

export function requirePasswordChanged(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.mustChangePassword) return next();

  // `originalUrl` rather than `req.path`, which is relative to the router this
  // middleware is mounted on and would not contain the module prefix.
  const url = req.originalUrl.split("?")[0];
  const allowed = ALLOWED_WHILE_PENDING.some(
    (entry) => entry.method === req.method && entry.path.test(url)
  );
  if (allowed) return next();

  next(
    ApiError.forbidden(
      "Set your own password before continuing. The one you were given is temporary."
    ).withCode("PASSWORD_CHANGE_REQUIRED")
  );
}
