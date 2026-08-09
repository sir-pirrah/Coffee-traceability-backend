import { prisma } from "@/repositories/prisma.client";

// ---------------------------------------------------------------------------
// System settings service + caches
// ---------------------------------------------------------------------------
// Same rationale as the permission cache: the maintenance switch must affect
// already-issued tokens, so it is read from the DB but cached in-process with
// a short TTL plus explicit invalidation on write.

const SINGLETON_ID = "singleton";
const SETTING_TTL_MS = 10_000;
const USER_ACCESS_TTL_MS = 10_000;

export interface SystemStatus {
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
}

let settingCache: { value: SystemStatus; expiresAt: number } | null = null;

// Per-user cache of the maintenanceAllowed flag, so the maintenance gate does
// not issue a DB read on every request for every user during an outage window.
const userAccessCache = new Map<string, { allowed: boolean; expiresAt: number }>();

async function loadSetting(): Promise<SystemStatus> {
  const row = await prisma.systemSetting.findUnique({ where: { id: SINGLETON_ID } });
  return {
    maintenanceMode: row?.maintenanceMode ?? false,
    maintenanceMessage: row?.maintenanceMessage ?? null,
  };
}

/** Current maintenance status, from cache when fresh. */
export async function getStatus(): Promise<SystemStatus> {
  const now = Date.now();
  if (settingCache && settingCache.expiresAt > now) {
    return settingCache.value;
  }
  const value = await loadSetting();
  settingCache = { value, expiresAt: now + SETTING_TTL_MS };
  return value;
}

function invalidateSetting(): void {
  settingCache = null;
}

/** True if the given user may use the system while maintenance is on. */
export async function isMaintenanceAllowedForUser(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = userAccessCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.allowed;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { maintenanceAllowed: true },
  });
  const allowed = user?.maintenanceAllowed ?? false;
  userAccessCache.set(userId, { allowed, expiresAt: now + USER_ACCESS_TTL_MS });
  return allowed;
}

/** Drops a single user's cached access flag (call after toggling it). */
export function invalidateUserAccess(userId: string): void {
  userAccessCache.delete(userId);
}

/** Updates the maintenance switch/message and invalidates the cache. */
export async function setMaintenance(
  input: { maintenanceMode: boolean; maintenanceMessage?: string | null },
  updatedById: string
): Promise<SystemStatus> {
  const row = await prisma.systemSetting.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      maintenanceMode: input.maintenanceMode,
      maintenanceMessage: input.maintenanceMessage ?? null,
      updatedById,
    },
    update: {
      maintenanceMode: input.maintenanceMode,
      maintenanceMessage: input.maintenanceMessage ?? null,
      updatedById,
    },
  });
  invalidateSetting();
  return {
    maintenanceMode: row.maintenanceMode,
    maintenanceMessage: row.maintenanceMessage,
  };
}
