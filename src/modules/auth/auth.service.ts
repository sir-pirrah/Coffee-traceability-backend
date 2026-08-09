import crypto from "node:crypto";
import { UserRole } from "@prisma/client";
import { prisma } from "@/repositories/prisma.client";
import { runAsSystem } from "@/repositories/dbContext";
import { ApiError } from "@/utils/ApiError";
import { hashPassword, verifyPassword } from "@/auth/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "@/auth/jwt";
import { classifyIdentifier, normalizePhone } from "@/auth/identifier";
import { getStatus } from "@/modules/system/system.service";
import { LoginInput, RegisterInput } from "./auth.validator";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * A real bcrypt hash of a value nobody holds, compared against when no user
 * matched. Without it the "unknown identifier" path returns in microseconds
 * while the "wrong password" path pays for a bcrypt round, and the difference is
 * measurable from outside — an oracle for which accounts exist. That matters
 * more now than it did when the only identifier was an email: farmer codes are
 * sequential, so an attacker can walk them.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.xn8bTOnPtAo1Zsrf6RGYUSKcpXqcXaG";

function hashToken(token: string): string {
  // Store only a hash of the refresh token — if the DB leaks, tokens
  // cannot be replayed directly.
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Which roles a caller may hand out. A COOPERATIVE_ADMIN administers their own
// cooperative, so they may staff it and enrol its members — but they may not
// mint a peer, and certainly not a SUPER_ADMIN.
//
// This has to be enforced here in application code: the `users_tenant` row-level
// policy checks the new row's `cooperative_id`, and says nothing at all about its
// `role`. As far as Postgres is concerned, a COOPERATIVE_ADMIN inserting a
// SUPER_ADMIN row into their own cooperative is a legal write.
const GRANTABLE_ROLES: Partial<Record<UserRole, UserRole[]>> = {
  SUPER_ADMIN: ["SUPER_ADMIN", "COOPERATIVE_ADMIN", "COOPERATIVE_STAFF", "FARMER", "BUYER", "AUDITOR"],
  COOPERATIVE_ADMIN: ["COOPERATIVE_STAFF", "FARMER", "BUYER"],
};

export interface Actor {
  id: string;
  role: UserRole;
  cooperativeId: string | null;
}

export async function register(input: RegisterInput, actor: Actor) {
  const grantable = GRANTABLE_ROLES[actor.role] ?? [];
  if (!grantable.includes(input.role)) {
    throw ApiError.forbidden(`You cannot create a ${input.role.replace(/_/g, " ").toLowerCase()} account`);
  }

  // A non-SUPER_ADMIN creates users inside their own cooperative, whatever the
  // request body claims. Ignoring the supplied value rather than comparing and
  // rejecting keeps the rule in one place and leaves nothing to forget.
  const cooperativeId =
    actor.role === "SUPER_ADMIN" ? input.cooperativeId ?? null : actor.cooperativeId;

  // Every role this endpoint can grant is cooperative-scoped except BUYER, who
  // trades across cooperatives and belongs to none. (SUPER_ADMIN is the other
  // unscoped role, but `registerSchema` does not accept it — a platform owner is
  // seeded, not registered.)
  if (!cooperativeId && input.role !== "BUYER") {
    throw ApiError.badRequest("cooperativeId is required for this role");
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw ApiError.conflict("An account with this email already exists");
  }

  const phoneNumber = input.phoneNumber ? normalizePhone(input.phoneNumber) ?? input.phoneNumber : undefined;

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phoneNumber,
      role: input.role,
      cooperativeId,
      status: "PENDING_VERIFICATION",
    },
    select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true },
  });

  return user;
}

/**
 * Resolves a typed identifier to the account it names.
 *
 * Each branch is a single indexed lookup — `users_email_key`,
 * `users_phone_number_key`, or `farmers_farmer_code_key` — so accepting three
 * kinds of identifier costs no more than accepting one did.
 *
 * The farmer-code branch reaches the user through the farmer row, which is the
 * whole point of provisioning: `farmers.user_id` is the link, and it is also
 * what `authenticate` reads back to scope every subsequent query.
 */
async function findByIdentifier(identifier: string) {
  const value = identifier.trim();

  switch (classifyIdentifier(value)) {
    case "email":
      return prisma.user.findUnique({ where: { email: value.toLowerCase() } });

    case "farmerCode": {
      const farmer = await prisma.farmer.findUnique({
        where: { farmerCode: value.toUpperCase() },
        select: { isDeleted: true, user: true },
      });
      if (!farmer || farmer.isDeleted) return null;
      return farmer.user;
    }

    case "phone": {
      const phone = normalizePhone(value);
      if (!phone) return null;
      return prisma.user.findUnique({ where: { phoneNumber: phone } });
    }
  }
}

export async function login(input: LoginInput) {
  const user = await findByIdentifier(input.identifier);

  // Same message and the same amount of work whether the account exists or not.
  if (!user || user.isDeleted) {
    await verifyPassword(input.password, DUMMY_HASH);
    throw ApiError.unauthorized("Invalid credentials");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.forbidden("Account temporarily locked due to repeated failed logins. Try again later.");
  }

  if (user.status !== "ACTIVE" && user.status !== "PENDING_VERIFICATION") {
    throw ApiError.forbidden("Account is not active. Contact your cooperative administrator.");
  }

  const validPassword = await verifyPassword(input.password, user.passwordHash);

  if (!validPassword) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });

    throw ApiError.unauthorized("Invalid credentials");
  }

  // An unclaimed credential stops working. The slip it was written on may have
  // been lost, photographed, or left on a desk months ago, and nobody would
  // know — so the account it opens does not stay open indefinitely.
  if (
    user.mustChangePassword &&
    user.temporaryPasswordExpiresAt &&
    user.temporaryPasswordExpiresAt < new Date()
  ) {
    throw ApiError.forbidden(
      "The temporary password you were given has expired. Ask your cooperative for a new one."
    ).withCode("TEMPORARY_PASSWORD_EXPIRED");
  }

  // Maintenance gate at the login boundary: non-allowed, non-SUPER_ADMIN users
  // "only get maintenance on login" — they never receive tokens while the
  // system is down. SUPER_ADMIN and explicitly-allowed users log in normally.
  if (user.role !== "SUPER_ADMIN" && !user.maintenanceAllowed) {
    const { maintenanceMode, maintenanceMessage } = await getStatus();
    if (maintenanceMode) {
      throw ApiError.serviceUnavailable(
        maintenanceMessage || "The system is currently under maintenance. Please try again later."
      ).withCode("MAINTENANCE");
    }
  }

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    cooperativeId: user.cooperativeId,
    mustChangePassword: user.mustChangePassword,
  });
  const refreshToken = signRefreshToken(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      refreshTokenHash: hashToken(refreshToken),
    },
  });

  return {
    accessToken,
    refreshToken,
    mustChangePassword: user.mustChangePassword,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      cooperativeId: user.cooperativeId,
    },
  };
}

export async function refresh(refreshToken: string) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub as string } });
  if (!user || user.isDeleted || user.refreshTokenHash !== hashToken(refreshToken)) {
    // Token reuse/mismatch detected — likely stolen or already rotated.
    throw ApiError.unauthorized("Refresh token is no longer valid");
  }

  const newAccessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    cooperativeId: user.cooperativeId,
    mustChangePassword: user.mustChangePassword,
  });
  const newRefreshToken = signRefreshToken(user.id);

  // Rotate refresh token on every use (prevents replay of old tokens).
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: hashToken(newRefreshToken) },
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Replaces the caller's own password, which is the only way out of the
 * temporary-password state.
 *
 * Runs in system context: a farmer arriving here has an identity but no reach —
 * the `users_tenant` policy lets them read and write their own row, but the
 * lookup and the update are keyed by the verified token's subject either way, so
 * this cannot be steered by request input.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await runAsSystem(() => prisma.user.findUnique({ where: { id: userId } }));
  if (!user || user.isDeleted) throw ApiError.unauthorized();

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw ApiError.unauthorized("Your current password is incorrect");

  // Not a strength rule but a purpose one: "change your password" that accepts
  // the same password back leaves the account exactly where it was, and would
  // clear the flag saying so.
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw ApiError.badRequest("Your new password must be different from your current one");
  }

  const passwordHash = await hashPassword(newPassword);
  const refreshToken = signRefreshToken(user.id);

  await runAsSystem(() =>
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // Rotated here so the tokens handed back below are the only live ones:
        // whatever the old refresh token was, it stops working.
        refreshTokenHash: hashToken(refreshToken),
        // An account provisioned as PENDING_VERIFICATION has, by choosing its own
        // password, done the only verification this system asks for.
        ...(user.status === "PENDING_VERIFICATION" && { status: "ACTIVE" as const }),
      },
    })
  );

  // Fresh tokens rather than making the caller log in again: the access token
  // carries `mustChangePassword`, so without this they would keep hitting the
  // gate they just cleared until the old one expired.
  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    cooperativeId: user.cooperativeId,
    mustChangePassword: false,
  });

  return { accessToken, refreshToken, mustChangePassword: false };
}

export async function logout(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshTokenHash: null },
  });
}
