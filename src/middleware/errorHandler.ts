import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/utils/ApiError";
import { logger } from "@/config/logger";
import { isProd } from "@/config/env";

// Centralized error handler — must be registered last. Normalizes
// Prisma errors, Zod-originated ApiErrors, and unexpected exceptions
// into one consistent JSON shape, and never leaks internals in prod.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = 500;
  let message = "Internal server error";
  let details: unknown;
  let code: string | undefined;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
    code = err.code;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      statusCode = 409;
      message = `A record with this ${(err.meta?.target as string[])?.join(", ") ?? "value"} already exists`;
    } else if (err.code === "P2025") {
      statusCode = 404;
      message = "Related record not found";
    } else {
      statusCode = 400;
      message = "Database request error";
    }
  } else if (err instanceof Error) {
    message = isProd ? message : err.message;
  }

  const logPayload = { statusCode, path: req.path, method: req.method, err };
  if (statusCode >= 500) {
    logger.error(logPayload, "Unhandled error");
  } else {
    logger.warn(logPayload, "Handled request error");
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ success: false, error: { message: `Route ${req.originalUrl} not found` } });
}
