export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  COOPERATIVE_ADMIN: "COOPERATIVE_ADMIN",
  COOPERATIVE_STAFF: "COOPERATIVE_STAFF",
  FARMER: "FARMER",
  BUYER: "BUYER",
  AUDITOR: "AUDITOR",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// Roles allowed to manage cooperative operational data (deliveries,
// batches, processing, warehouse). Used across module authorization.
export const STAFF_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.COOPERATIVE_ADMIN, ROLES.COOPERATIVE_STAFF];
export const ADMIN_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.COOPERATIVE_ADMIN];
