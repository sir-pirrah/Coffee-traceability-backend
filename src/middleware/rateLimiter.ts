import rateLimit from "express-rate-limit";
import { env } from "@/config/env";

// General API limiter — protects against abuse and brute-force scraping.
export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: "Too many requests, please try again later." } },
});

// Tighter limiter specifically for auth endpoints (login/register) to
// slow down credential-stuffing and brute-force attacks.
export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, error: { message: "Too many auth attempts, please try again later." } },
});
