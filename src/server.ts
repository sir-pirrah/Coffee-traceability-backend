import { createApp } from "@/app";
import { env } from "@/config/env";
import { logger } from "@/config/logger";
import { prisma, disconnectPrisma } from "@/repositories/prisma.client";

async function main() {
  await prisma.$connect();
  logger.info("Database connected");

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Coffee Traceability API listening on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  // Graceful shutdown — finish in-flight requests, close the DB pool,
  // then exit. Prevents dropped connections during redeploys.
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
