import { prisma } from "@/repositories/prisma.client";
import { ApiError } from "@/utils/ApiError";
import { Prisma } from "@prisma/client";

export async function createCooperative(data: Prisma.CooperativeCreateInput) {
  return prisma.cooperative.create({ data });
}

export async function listCooperatives(opts: {
  page: number;
  limit: number;
  county?: string;
  search?: string;
  // Restricts the listing to a single cooperative. The controller sets this
  // for non-SUPER_ADMIN callers so they only ever see their own society.
  id?: string;
}) {
  const where: Prisma.CooperativeWhereInput = {
    ...(opts.id && { id: opts.id }),
    ...(opts.county && { county: opts.county }),
    ...(opts.search && { name: { contains: opts.search, mode: "insensitive" } }),
  };

  const [items, total] = await Promise.all([
    prisma.cooperative.findMany({
      where,
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.cooperative.count({ where }),
  ]);

  return { items, total };
}

export async function getCooperativeById(id: string) {
  const coop = await prisma.cooperative.findUnique({ where: { id } });
  if (!coop) throw ApiError.notFound("Cooperative not found");
  return coop;
}

export async function updateCooperative(id: string, data: Prisma.CooperativeUpdateInput) {
  await getCooperativeById(id);
  return prisma.cooperative.update({ where: { id }, data });
}

export async function deactivateCooperative(id: string) {
  await getCooperativeById(id);
  return prisma.cooperative.update({ where: { id }, data: { isActive: false } });
}
