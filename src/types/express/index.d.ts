import { Role } from "@/constants/roles";

// Extend Express's Request type so `req.user` is available and typed
// everywhere after the `authenticate` middleware runs.
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: Role;
        cooperativeId: string | null;
        // Set from the access token; `requirePasswordChanged` is what acts on it.
        mustChangePassword?: boolean;
      };
    }
  }
}

export {};
