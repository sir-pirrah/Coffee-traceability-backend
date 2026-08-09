import { prisma } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import { Prisma, UserRole, UserStatus } from "@prisma/client";

const SAFE_SELECT = {
  id: true, email: true, firstName: true, lastName: true, role: true,
  status: true, cooperativeId: true, phoneNumber: true, lastLoginAt: true,
  maintenanceAllowed: true, createdAt: true,
} satisfies Prisma.UserSelect;

export async function getMe(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
  if (!user) throw ApiError.notFound("User not found");
  return user;
}

export async function listUsers(opts: { page: number; limit: number; cooperativeId?: string; role?: UserRole }) {
  const where: Prisma.UserWhereInput = {
    isDeleted: false,
    ...(opts.cooperativeId && { cooperativeId: opts.cooperativeId }),
    ...(opts.role && { role: opts.role }),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where, select: SAFE_SELECT, skip: (opts.page - 1) * opts.limit, take: opts.limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total };
}

export async function updateUserStatus(id: string, status: UserStatus) {
  const user = await prisma.user.findFirst({ where: { id, isDeleted: false } });
  if (!user) throw ApiError.notFound("User not found");
  return prisma.user.update({ where: { id }, data: { status }, select: SAFE_SELECT });
}

// Grants or revokes a user's ability to keep using the system while it is in
// maintenance mode. Caller must hold `users:manage`.
export async function setMaintenanceAccess(id: string, allowed: boolean) {
  const user = await prisma.user.findFirst({ where: { id, isDeleted: false } });
  if (!user) throw ApiError.notFound("User not found");
  return prisma.user.update({ where: { id }, data: { maintenanceAllowed: allowed }, select: SAFE_SELECT });
}
