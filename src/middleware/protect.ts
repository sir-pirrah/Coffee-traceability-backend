import { authenticate } from "@/middleware/authenticate";
import { maintenanceGate } from "@/middleware/maintenance";
import { requirePasswordChanged } from "@/middleware/requirePasswordChanged";

// Standard guard chain for every protected router: verify the token, enforce
// maintenance mode, then hold back anyone still on a temporary password. Use
// `router.use(...protect)` in place of `router.use(authenticate)`.
//
// The password gate belongs here rather than on individual routers so a new
// module cannot forget it: an account that has never chosen its own password
// reaches nothing by default, and the few endpoints it does need are named
// inside that middleware.
export const protect = [authenticate, maintenanceGate, requirePasswordChanged] as const;
