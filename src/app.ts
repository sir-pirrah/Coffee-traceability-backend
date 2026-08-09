import express, { Express } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "node:path";
import { env } from "@/config/env";
import { logger } from "@/config/logger";
import { apiLimiter } from "@/middleware/rateLimiter";
import { dbContextScope } from "@/middleware/dbContext";
import { errorHandler, notFoundHandler } from "@/middleware/errorHandler";
import apiRoutes from "@/routes";

export function createApp(): Express {
  const app = express();

  // Trust the first proxy hop (Railway/Vercel) so req.ip and rate
  // limiting reflect the real client IP rather than the proxy's.
  app.set("trust proxy", 1);

  // ---- Security headers ----
  app.use(helmet());

  // ---- CORS allow-list (only the Angular frontend origin) ----
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    })
  );

  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  // ---- Global rate limiting (auth endpoints have their own stricter limiter) ----
  app.use(env.API_PREFIX, apiLimiter);

  // ---- Per-request database context for row-level security ----
  // Opens the async scope that carries the caller's identity down to Postgres.
  // Mounted for the whole API rather than inside `protect`, so unauthenticated
  // requests also get a context — an empty one, which the policies match to no
  // rows. That way a route that forgets to authenticate leaks nothing.
  app.use(env.API_PREFIX, dbContextScope);

  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, status: "ok", timestamp: new Date().toISOString() });
  });

  // ---- API docs ----
  try {
    const swaggerDocument = YAML.load(path.join(__dirname, "..", "swagger.yaml")) as Record<string, unknown>;
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  } catch {
    logger.warn("swagger.yaml not found — skipping API docs route");
  }

  app.use(env.API_PREFIX, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
