import pino from "pino";
import { env, isProd } from "./env";

// Structured logging via Pino. Pretty-printed in development,
// JSON (machine-parseable) in production for log aggregation.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    // Never let secrets or credentials leak into logs.
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.refreshToken",
    ],
    censor: "[REDACTED]",
  },
  transport: isProd
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});
