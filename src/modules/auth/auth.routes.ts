import { Router } from "express";
import { validate } from "@/middleware/validate";
import { authenticate } from "@/middleware/authenticate";
import { protect } from "@/middleware/protect";
import { requirePermission } from "@/middleware/authorize";
import { authLimiter } from "@/middleware/rateLimiter";
import { systemContext } from "@/middleware/dbContext";
import { registerSchema, loginSchema, refreshSchema, changePasswordSchema } from "./auth.validator";
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  changePasswordHandler,
  logoutHandler,
} from "./auth.controller";

const router = Router();

// `/register` creates a user account, which is an administrative act, not part
// of the authentication bootstrap. It is mounted first and given the full guard
// chain — including its own `systemContext` *after* `protect`, so the identity
// has already been established and checked before policies are stepped around
// to write the new row.
//
// Left public, this endpoint accepted `role: "COOPERATIVE_ADMIN"` with any
// `cooperativeId`: anyone able to reach the API could mint an administrator
// inside any cooperative. Which roles a given caller may actually grant is
// narrowed again in the service.
router.post(
  "/register",
  authLimiter,
  ...protect,
  requirePermission("users:manage"),
  systemContext,
  validate(registerSchema),
  registerHandler
);

// Everything below is the bootstrap: these handlers must read and write `users`
// before any caller identity exists, so row-level security has nothing to match
// on yet. They run in system context, which bypasses the policies. It is safe
// here because each one is keyed by a credential the caller had to supply — an
// identifier plus password, or a signed refresh token — not by a client-chosen
// id.
router.use(systemContext);

router.post("/login", authLimiter, validate(loginSchema), loginHandler);
router.post("/refresh", authLimiter, validate(refreshSchema), refreshHandler);

// Reachable while `mustChangePassword` is set — it is the way out of that state —
// so it takes `authenticate` rather than the full `protect` chain, which would
// bounce the very people who need it. `authLimiter` still applies: the handler
// verifies a password, so it is a guessing surface like login.
router.post(
  "/change-password",
  authLimiter,
  authenticate,
  validate(changePasswordSchema),
  changePasswordHandler
);

router.post("/logout", authenticate, logoutHandler);

export default router;
