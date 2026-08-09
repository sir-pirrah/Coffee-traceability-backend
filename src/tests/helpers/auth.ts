/**
 * Token minting for tests.
 *
 * `authenticate` verifies the JWT without touching the database, so a signed
 * token is enough to exercise routing, permission, and scoping logic. Suites
 * that assert on real rows still create fixtures through Prisma.
 */
import { signAccessToken } from "@/auth/jwt";
import { Role } from "@/constants/roles";

export interface TestIdentity {
  id: string;
  role: Role;
  cooperativeId: string | null;
  /** Mints a token still carrying the forced-password-change claim. */
  mustChangePassword?: boolean;
}

export function tokenFor(identity: TestIdentity): string {
  return signAccessToken({
    sub: identity.id,
    role: identity.role,
    cooperativeId: identity.cooperativeId,
    mustChangePassword: identity.mustChangePassword ?? false,
  });
}

/** `Authorization` header ready to hand to supertest's `.set()`. */
export function authHeader(identity: TestIdentity): [string, string] {
  return ["Authorization", `Bearer ${tokenFor(identity)}`];
}
