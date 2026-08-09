import { UserRole } from "@prisma/client";
import { prisma } from "@/repositories/prisma.client";
import { isPermissionKey } from "@/constants/permissions";

// ---------------------------------------------------------------------------
// Permission service + in-memory cache
// ---------------------------------------------------------------------------
// The `authenticate` middleware deliberately never hits the DB, so permission
// checks can't be derived from the JWT alone (a matrix edit must take effect
// for already-issued tokens). We therefore read the current matrix from the
// database, but cache it in-memory to avoid a query per request.
//
// Freshness is guaranteed by BOTH a short TTL and an explicit invalidate() on
// every write. NOTE: this cache is per-process — a multi-instance deployment
// needs a shared cache / pub-sub invalidation (or must rely solely on the TTL).

const CACHE_TTL_MS = 15_000;

type Matrix = Map<UserRole, Set<string>>;

let cache: { matrix: Matrix; expiresAt: number } | null = null;

async function loadMatrix(): Promise<Matrix> {
  const rows = await prisma.rolePermission.findMany({
    select: { role: true, permission: true },
  });
  const matrix: Matrix = new Map();
  for (const { role, permission } of rows) {
    let set = matrix.get(role);
    if (!set) {
      set = new Set<string>();
      matrix.set(role, set);
    }
    set.add(permission);
  }
  return matrix;
}

/** Returns the current role→permissions matrix, from cache when fresh. */
export async function getMatrix(): Promise<Matrix> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.matrix;
  }
  const matrix = await loadMatrix();
  cache = { matrix, expiresAt: now + CACHE_TTL_MS };
  return matrix;
}

/** Drops the cached matrix so the next read reloads from the database. */
export function invalidate(): void {
  cache = null;
}

/**
 * True if `role` currently holds `permission`. SUPER_ADMIN always passes — a
 * safety net so the platform owner can never be locked out by an errant matrix
 * edit.
 */
export async function roleHasPermission(role: UserRole, permission: string): Promise<boolean> {
  if (role === "SUPER_ADMIN") return true;
  const matrix = await getMatrix();
  return matrix.get(role)?.has(permission) ?? false;
}

/** Effective permission keys for a role (SUPER_ADMIN gets the full catalog). */
export async function getPermissionsForRole(role: UserRole): Promise<string[]> {
  const matrix = await getMatrix();
  return [...(matrix.get(role) ?? [])];
}

/** The whole matrix as a plain object for API responses. */
export async function getMatrixObject(): Promise<Record<string, string[]>> {
  const matrix = await getMatrix();
  const out: Record<string, string[]> = {};
  for (const [role, set] of matrix) {
    out[role] = [...set];
  }
  return out;
}

/**
 * Replaces all permissions for a role in a single transaction, then
 * invalidates the cache. Unknown keys are rejected by the caller (route
 * validation), but we defensively filter here too.
 */
export async function setRolePermissions(role: UserRole, permissions: string[]): Promise<string[]> {
  const clean = [...new Set(permissions.filter(isPermissionKey))];

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { role } }),
    prisma.rolePermission.createMany({
      data: clean.map((permission) => ({ role, permission })),
      skipDuplicates: true,
    }),
  ]);

  invalidate();
  return clean;
}
