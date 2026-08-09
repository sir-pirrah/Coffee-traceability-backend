import { NextFunction, Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { asyncHandler } from "@/utils/asyncHandler";
import { verifyAccessToken } from "@/auth/jwt";
import { prisma } from "@/repositories/prisma.client";
import { getDbContext, runAsSystem } from "@/repositories/dbContext";

// Verifies the Bearer access token and attaches the decoded identity to
// req.user, then publishes the same identity to the request's database context
// so Postgres's row-level security policies can see who is asking.
//
// Async because a FARMER's `Farmer` profile id has to be resolved before their
// first scoped query: the policies narrow a farmer by that id, and it isn't in
// the token. One indexed lookup per farmer request, cached on the context for
// the rest of it. Every other role skips the query entirely.
async function authenticateHandler(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    throw ApiError.unauthorized("Missing or malformed Authorization header");
  }

  const token = header.slice("Bearer ".length);

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized("Invalid or expired access token");
  }

  req.user = {
    id: payload.sub,
    role: payload.role,
    cooperativeId: payload.cooperativeId,
    mustChangePassword: payload.mustChangePassword === true,
  };

  let farmerId: string | null = null;
  if (payload.role === "FARMER") {
    // System context because the farmers policy filters on the very id being
    // looked up here. Narrowed to this one lookup, keyed by the verified token's
    // subject, so it cannot be steered by request input.
    const farmer = await runAsSystem(() =>
      prisma.farmer.findFirst({ where: { userId: payload.sub, isDeleted: false }, select: { id: true } })
    );
    farmerId = farmer?.id ?? null;
  }

  // Mutate the scope `dbContextScope` already opened rather than nesting a new
  // one: Express middleware returns before the route handlers run, so a nested
  // scope would be gone by the time the queries that need it are made.
  const store = getDbContext();
  if (store) {
    store.userId = payload.sub;
    store.role = payload.role;
    store.cooperativeId = payload.cooperativeId ?? null;
    store.farmerId = farmerId;
  }

  next();
}

// Express 4 does not attach a catch to an async middleware's returned promise,
// so an unhandled rejection here would hang the request instead of producing a
// 401. asyncHandler forwards it to the error handler.
export const authenticate = asyncHandler(authenticateHandler);
