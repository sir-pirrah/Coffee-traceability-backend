import { UserRole } from "@prisma/client";

// ---------------------------------------------------------------------------
// Permission catalog
// ---------------------------------------------------------------------------
// The *full set* of permission keys the app understands lives here in code —
// only the granted (role, permission) pairs live in the database
// (RolePermission), so the matrix is editable at runtime without shipping new
// keys. Keep this list in sync with the frontend mirror
// (playground/src/app/core/constants/permissions.ts).
//
// A key is "<resource>:<action>". `group` is used purely to lay the matrix out
// in the admin UI.

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
}

export const PERMISSIONS: readonly PermissionDef[] = [
  { key: "dashboard:view", label: "View dashboard", group: "General" },

  { key: "farmers:view", label: "View farmers", group: "Farmers" },
  { key: "farmers:create", label: "Add / edit farmers", group: "Farmers" },
  // Separate from `farmers:create` on purpose: registering a farmer records
  // someone in the books, while issuing a login hands out a credential that
  // reads real delivery and batch records. The second is the heavier act.
  { key: "farmers:manage-account", label: "Create / reset farmer logins", group: "Farmers" },

  { key: "deliveries:view", label: "View deliveries", group: "Deliveries" },
  { key: "deliveries:create", label: "Record deliveries", group: "Deliveries" },

  { key: "batches:view", label: "View batches", group: "Batches" },
  { key: "batches:create", label: "Create batches", group: "Batches" },
  { key: "batches:transition", label: "Change batch status", group: "Batches" },

  { key: "processing:view", label: "View processing", group: "Processing" },
  { key: "processing:create", label: "Record processing", group: "Processing" },

  { key: "warehouse:view", label: "View warehouses", group: "Warehouse" },
  { key: "warehouse:create", label: "Register warehouses", group: "Warehouse" },
  { key: "warehouse:store", label: "Store batches", group: "Warehouse" },

  { key: "reports:view", label: "View reports", group: "Reports" },
  { key: "blockchain:view", label: "View blockchain / traceability", group: "Reports" },

  { key: "users:view", label: "View users", group: "Administration" },
  { key: "users:manage", label: "Manage users", group: "Administration" },

  { key: "roles:view", label: "View roles & permissions", group: "Administration" },
  { key: "roles:manage", label: "Edit roles & permissions", group: "Administration" },

  { key: "settings:view", label: "View settings", group: "Administration" },
  { key: "settings:manage", label: "Edit settings", group: "Administration" },

  { key: "system:maintenance", label: "Control system maintenance", group: "Administration" },
] as const;

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): boolean {
  return PERMISSION_KEYS.includes(value);
}

// Convenience groupings used to build the default matrix below.
const ALL = PERMISSION_KEYS as string[];
const VIEW_ONLY = ALL.filter((k) => k.endsWith(":view"));

// ---------------------------------------------------------------------------
// Default matrix
// ---------------------------------------------------------------------------
// Encodes today's role behavior. Used by the seed and as the "reset to
// defaults" baseline. SUPER_ADMIN is granted everything for completeness, but
// the service also hard-bypasses SUPER_ADMIN so it can never be locked out.

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  SUPER_ADMIN: [...ALL],

  COOPERATIVE_ADMIN: [
    "dashboard:view",
    "farmers:view", "farmers:create", "farmers:manage-account",
    "deliveries:view", "deliveries:create",
    "batches:view", "batches:create", "batches:transition",
    "processing:view", "processing:create",
    "warehouse:view", "warehouse:create", "warehouse:store",
    "reports:view", "blockchain:view",
    "users:view", "users:manage",
    "roles:view",
    "settings:view", "settings:manage",
  ],

  COOPERATIVE_STAFF: [
    "dashboard:view",
    "farmers:view", "farmers:create",
    "deliveries:view", "deliveries:create",
    "batches:view", "batches:create", "batches:transition",
    "processing:view", "processing:create",
    "warehouse:view", "warehouse:store",
    "reports:view", "blockchain:view",
    "settings:view",
  ],

  AUDITOR: [...VIEW_ONLY, "settings:view"],

  FARMER: [
    "dashboard:view",
    "deliveries:view",
    "batches:view",
    "settings:view",
  ],

  BUYER: [
    "dashboard:view",
    "batches:view",
    "blockchain:view",
    "settings:view",
  ],
};
