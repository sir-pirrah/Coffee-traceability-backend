import { Prisma, UserRole } from "@prisma/client";
import { prisma, withTransaction } from "@/repositories/prisma.client";
import { runAsSystem } from "@/repositories/dbContext";
import { ApiError } from "@/utils/ApiError";
import { nextEntityCode } from "@/utils/entityCode";
import { hashPassword } from "@/auth/password";
import { normalizePhone } from "@/auth/identifier";
import { generateTemporaryPassword, temporaryPasswordExpiry } from "@/auth/temporaryPassword";

// FARM-YYYY-NNNNN — human-readable, sortable, still globally unique.
//
// Numbering runs through the shared atomic counter rather than COUNT(*): a
// farmer code is now a login identifier, so two concurrent registrations
// deriving the same one is not merely a unique-constraint 500 — it is two people
// pointed at one credential.
async function generateFarmerCode(client?: Prisma.TransactionClient): Promise<string> {
  return nextEntityCode("farmer", "FARM", 5, client);
}

/**
 * The credential slip. Returned once, at the moment of issue, and never
 * retrievable again — only the bcrypt hash is kept.
 */
export interface IssuedCredentials {
  identifier: string;
  temporaryPassword: string;
  expiresAt: Date;
}

export interface CreateFarmerAccountOptions {
  email?: string;
}

// Takes the *unchecked* create input so callers can pass the scalar
// `cooperativeId` straight through from the request body. Mixing that scalar
// with a `cooperative: { connect }` relation is what Prisma's checked input
// rejects, so we use one style consistently rather than both.
export async function createFarmer(
  data: Omit<Prisma.FarmerUncheckedCreateInput, "farmerCode"> & { cooperativeId: string }
) {
  const cooperative = await prisma.cooperative.findUnique({ where: { id: data.cooperativeId } });
  if (!cooperative) throw ApiError.badRequest("Invalid cooperativeId");

  const phoneNumber = data.phoneNumber ? normalizePhone(data.phoneNumber) ?? data.phoneNumber : data.phoneNumber;

  return withTransaction(async (tx) => {
    const farmerCode = await generateFarmerCode(tx);
    return tx.farmer.create({ data: { ...data, phoneNumber, farmerCode } });
  });
}

/**
 * Registers a farmer and issues them a login in one transaction.
 *
 * One call rather than two because the halves are not independently useful: a
 * farmer row with a half-created user, or a user with no farmer to scope them
 * to, are both states the rest of the system has no handling for.
 */
export async function createFarmerWithAccount(
  data: Omit<Prisma.FarmerUncheckedCreateInput, "farmerCode"> & { cooperativeId: string },
  options: CreateFarmerAccountOptions = {}
): Promise<{ farmer: Prisma.FarmerGetPayload<object>; credentials: IssuedCredentials }> {
  const cooperative = await prisma.cooperative.findUnique({ where: { id: data.cooperativeId } });
  if (!cooperative) throw ApiError.badRequest("Invalid cooperativeId");

  const email = normalizeEmail(options.email);
  const phoneNumber = data.phoneNumber ? normalizePhone(data.phoneNumber) ?? data.phoneNumber : null;

  await assertIdentifiersFree(email, phoneNumber);

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const expiresAt = temporaryPasswordExpiry();

  const farmer = await withTransaction(async (tx) => {
    const farmerCode = await generateFarmerCode(tx);

    const user = await tx.user.create({
      data: buildFarmerUser({
        email,
        phoneNumber,
        firstName: data.firstName,
        lastName: data.lastName,
        cooperativeId: data.cooperativeId,
        passwordHash,
        expiresAt,
      }),
      select: { id: true },
    });

    return tx.farmer.create({
      data: { ...data, phoneNumber, farmerCode, userId: user.id },
    });
  });

  return {
    farmer,
    credentials: { identifier: farmer.farmerCode, temporaryPassword, expiresAt },
  };
}

/**
 * Issues a login to a farmer who was registered before this feature existed, or
 * whose registration skipped the optional login step.
 */
export async function createFarmerAccount(
  farmerId: string,
  options: CreateFarmerAccountOptions = {}
): Promise<IssuedCredentials> {
  const farmer = await getFarmerById(farmerId);

  if (farmer.userId) {
    throw ApiError.conflict(
      "This farmer already has a login. Reset their password instead of creating a second account."
    );
  }

  const email = normalizeEmail(options.email);
  const phoneNumber = farmer.phoneNumber ? normalizePhone(farmer.phoneNumber) : null;

  await assertIdentifiersFree(email, phoneNumber);

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const expiresAt = temporaryPasswordExpiry();

  await withTransaction(async (tx) => {
    const user = await tx.user.create({
      data: buildFarmerUser({
        email,
        phoneNumber,
        firstName: farmer.firstName,
        lastName: farmer.lastName,
        cooperativeId: farmer.cooperativeId,
        passwordHash,
        expiresAt,
      }),
      select: { id: true },
    });

    // Linking here is what makes the account work at all: `authenticate`
    // resolves a FARMER's scope by looking their user id up in `farmers.user_id`,
    // and every row-level policy narrows on the result. An unlinked account
    // authenticates and then sees nothing.
    await tx.farmer.update({ where: { id: farmer.id }, data: { userId: user.id } });
  });

  return { identifier: farmer.farmerCode, temporaryPassword, expiresAt };
}

/**
 * Issues a fresh temporary password for a farmer who has lost theirs, or whose
 * slip has expired.
 *
 * Clears the stored refresh-token hash so an existing session cannot be extended
 * past the current access token's lifetime. That token itself stays valid for up
 * to `JWT_ACCESS_EXPIRES_IN` — pre-existing behaviour, shared with status
 * changes, and the reason a reset is not a substitute for suspending an account.
 */
export async function resetFarmerPassword(farmerId: string): Promise<IssuedCredentials> {
  const farmer = await getFarmerById(farmerId);

  if (!farmer.userId) {
    throw ApiError.badRequest("This farmer has no login yet. Create one first.");
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const expiresAt = temporaryPasswordExpiry();

  await prisma.user.update({
    where: { id: farmer.userId },
    data: {
      passwordHash,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: expiresAt,
      refreshTokenHash: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  return { identifier: farmer.farmerCode, temporaryPassword, expiresAt };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeEmail(email?: string): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

/**
 * The user row a farmer account always is.
 *
 * `role` is a literal and `cooperativeId` comes from the farmer record — neither
 * is ever taken from request input. The row-level policy on `users` checks the
 * new row's cooperative but says nothing about its role, so this function is the
 * only thing standing between "provision a farmer" and "provision a
 * SUPER_ADMIN".
 */
function buildFarmerUser(input: {
  email: string | null;
  phoneNumber: string | null;
  firstName: string;
  lastName: string;
  cooperativeId: string;
  passwordHash: string;
  expiresAt: Date;
}): Prisma.UserUncheckedCreateInput {
  return {
    email: input.email,
    phoneNumber: input.phoneNumber,
    passwordHash: input.passwordHash,
    firstName: input.firstName,
    lastName: input.lastName,
    role: "FARMER" satisfies UserRole,
    cooperativeId: input.cooperativeId,
    // ACTIVE rather than PENDING_VERIFICATION: there is no verification channel
    // to wait on — an administrator handed the credential over in person, which
    // is a stronger check than a mail round-trip. The forced password change is
    // what stands in for it.
    status: "ACTIVE",
    mustChangePassword: true,
    temporaryPasswordExpiresAt: input.expiresAt,
  };
}

/**
 * Catches an identifier clash before the transaction, so the caller gets a
 * sentence they can act on instead of a unique-constraint 500.
 *
 * The phone check is the one that actually fires in practice: `users.phone_number`
 * is globally unique, and a household often shares a handset. The message says so
 * rather than blaming the farmer's own details, because the fix is to leave the
 * phone off and let them sign in with their farmer code.
 */
async function assertIdentifiersFree(email: string | null, phoneNumber: string | null): Promise<void> {
  // System context: a clash may well be with an account in another cooperative,
  // which the caller cannot see and must still be told about.
  if (email) {
    const taken = await runAsSystem(() => prisma.user.findUnique({ where: { email }, select: { id: true } }));
    if (taken) throw ApiError.conflict("An account with this email already exists");
  }

  if (phoneNumber) {
    const taken = await runAsSystem(() =>
      prisma.user.findUnique({ where: { phoneNumber }, select: { id: true } })
    );
    if (taken) {
      throw ApiError.conflict(
        "Another account already signs in with this phone number. Leave it off and this farmer " +
          "can sign in with their farmer code instead."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listFarmers(opts: {
  page: number;
  limit: number;
  cooperativeId?: string;
  search?: string;
}) {
  const where: Prisma.FarmerWhereInput = {
    isDeleted: false,
    ...(opts.cooperativeId && { cooperativeId: opts.cooperativeId }),
    ...(opts.search && {
      OR: [
        { firstName: { contains: opts.search, mode: "insensitive" } },
        { lastName: { contains: opts.search, mode: "insensitive" } },
        { farmerCode: { contains: opts.search, mode: "insensitive" } },
      ],
    }),
  };

  const [items, total] = await Promise.all([
    prisma.farmer.findMany({
      where,
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      orderBy: { createdAt: "desc" },
      // `hasLogin` drives the per-row action in the UI — whether it offers
      // "create a login" or "reset password". The user relation itself is not
      // selected: nothing about the account belongs in a farmer list.
      include: { user: { select: { id: true } } },
    }),
    prisma.farmer.count({ where }),
  ]);

  return {
    items: items.map(({ user, ...farmer }) => ({ ...farmer, hasLogin: user !== null })),
    total,
  };
}

export async function getFarmerById(id: string) {
  const farmer = await prisma.farmer.findFirst({ where: { id, isDeleted: false } });
  if (!farmer) throw ApiError.notFound("Farmer not found");
  return farmer;
}

export async function updateFarmer(id: string, data: Prisma.FarmerUpdateInput) {
  await getFarmerById(id);
  return prisma.farmer.update({ where: { id }, data });
}

// Soft delete — preserves delivery/batch history integrity for traceability.
//
// The linked login is deactivated with it: leaving a working credential attached
// to a farmer the cooperative has removed from its books is the gap someone
// walks back in through.
export async function softDeleteFarmer(id: string) {
  const farmer = await getFarmerById(id);

  return withTransaction(async (tx) => {
    if (farmer.userId) {
      await tx.user.update({ where: { id: farmer.userId }, data: { status: "DEACTIVATED", refreshTokenHash: null } });
    }
    return tx.farmer.update({ where: { id }, data: { isDeleted: true, isActive: false } });
  });
}
