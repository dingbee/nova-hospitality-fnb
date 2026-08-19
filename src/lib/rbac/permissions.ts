/**
 * NOVA Hospitality F&B — RBAC catalogue (single source of truth).
 *
 * This module is the ONLY place roles, permission domains and the role →
 * permission matrix are declared. The database seed in
 * `standalone/db/migrations/0003_tenancy_rbac.sql` is generated from it, and
 * the server-side guard resolves against the same codes, so UI, API and SQL
 * can never drift apart.
 *
 * UI hiding is presentation. Enforcement happens server-side in
 * `rbac.server.ts` and in SQL via `public.nova_has_permission`.
 */

export const PERMISSION_DOMAINS = [
  "RESERVATIONS",
  "RESTAURANT",
  "BAR",
  "POS",
  "ORDERS",
  "KITCHEN",
  "INVENTORY",
  "PROCUREMENT",
  "SUPPLIERS",
  "MENU",
  "PRICING",
  "COSTING",
  "FINANCE",
  "REPORTS",
  "STAFF",
  "SETTINGS",
  "AUDIT",
  "ADMINISTRATION",
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export const PERMISSION_ACTIONS = ["READ", "WRITE", "APPROVE", "ADMIN"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type Permission = `${PermissionDomain}:${PermissionAction}`;

export function permission(domain: PermissionDomain, action: PermissionAction): Permission {
  return `${domain}:${action}`;
}

export const ALL_PERMISSIONS: Permission[] = PERMISSION_DOMAINS.flatMap((d) =>
  PERMISSION_ACTIONS.map((a) => permission(d, a)),
);

export const ROLES = [
  "OWNER",
  "GENERAL_MANAGER",
  "RESTAURANT_MANAGER",
  "BAR_MANAGER",
  "CHEF",
  "WAITER",
  "BARTENDER",
  "CASHIER",
  "STOREKEEPER",
  "PROCUREMENT",
  "FINANCE",
  "AUDITOR",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  GENERAL_MANAGER: "General manager",
  RESTAURANT_MANAGER: "Restaurant manager",
  BAR_MANAGER: "Bar manager",
  CHEF: "Chef",
  WAITER: "Waiter",
  BARTENDER: "Bartender",
  CASHIER: "Cashier",
  STOREKEEPER: "Storekeeper",
  PROCUREMENT: "Procurement",
  FINANCE: "Finance",
  AUDITOR: "Auditor",
};

/** Scope a role is normally assigned at. Assignment may always be narrower. */
export const ROLE_SCOPE: Record<Role, "TENANT" | "PROPERTY" | "OUTLET"> = {
  OWNER: "TENANT",
  GENERAL_MANAGER: "PROPERTY",
  RESTAURANT_MANAGER: "OUTLET",
  BAR_MANAGER: "OUTLET",
  CHEF: "OUTLET",
  WAITER: "OUTLET",
  BARTENDER: "OUTLET",
  CASHIER: "OUTLET",
  STOREKEEPER: "PROPERTY",
  PROCUREMENT: "PROPERTY",
  FINANCE: "PROPERTY",
  AUDITOR: "TENANT",
};

const all = (d: PermissionDomain): Permission[] => PERMISSION_ACTIONS.map((a) => permission(d, a));
const rw = (d: PermissionDomain): Permission[] => [permission(d, "READ"), permission(d, "WRITE")];
const ro = (d: PermissionDomain): Permission[] => [permission(d, "READ")];

/** Read-only across every domain — the auditor contract. */
const READ_EVERYTHING: Permission[] = PERMISSION_DOMAINS.map((d) => permission(d, "READ"));

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: ALL_PERMISSIONS,

  GENERAL_MANAGER: [
    ...all("RESERVATIONS"), ...all("RESTAURANT"), ...all("BAR"), ...all("POS"),
    ...all("ORDERS"), ...all("KITCHEN"), ...all("INVENTORY"), ...all("PROCUREMENT"),
    ...all("SUPPLIERS"), ...all("MENU"), ...all("PRICING"), ...all("COSTING"),
    ...rw("FINANCE"), permission("FINANCE", "APPROVE"),
    ...ro("REPORTS"), ...rw("STAFF"), ...rw("SETTINGS"), ...ro("AUDIT"),
  ],

  RESTAURANT_MANAGER: [
    ...rw("RESERVATIONS"), ...all("RESTAURANT"), ...rw("POS"), ...all("ORDERS"),
    ...rw("KITCHEN"), ...rw("INVENTORY"), ...rw("PROCUREMENT"),
    permission("PROCUREMENT", "APPROVE"), ...ro("SUPPLIERS"), ...all("MENU"),
    ...rw("PRICING"), ...rw("COSTING"), ...ro("FINANCE"), ...ro("REPORTS"),
    ...ro("STAFF"), ...ro("SETTINGS"),
  ],

  BAR_MANAGER: [
    ...all("BAR"), ...rw("POS"), ...rw("ORDERS"), ...rw("INVENTORY"),
    ...rw("PROCUREMENT"), ...ro("SUPPLIERS"), ...rw("MENU"), ...rw("PRICING"),
    ...rw("COSTING"), ...ro("REPORTS"), ...ro("SETTINGS"),
  ],

  CHEF: [
    ...ro("RESTAURANT"), ...ro("ORDERS"), ...all("KITCHEN"), ...rw("INVENTORY"),
    ...rw("MENU"), ...ro("COSTING"), ...rw("PROCUREMENT"), ...ro("SUPPLIERS"),
    ...ro("REPORTS"),
  ],

  WAITER: [
    ...ro("RESTAURANT"), ...rw("POS"), ...rw("ORDERS"), ...ro("KITCHEN"),
    ...ro("MENU"), ...ro("RESERVATIONS"),
  ],

  BARTENDER: [...ro("BAR"), ...rw("POS"), ...rw("ORDERS"), ...ro("MENU"), ...ro("INVENTORY")],

  CASHIER: [
    ...rw("POS"), ...rw("ORDERS"), ...ro("MENU"), ...ro("FINANCE"), ...ro("REPORTS"),
  ],

  STOREKEEPER: [
    ...all("INVENTORY"), ...rw("PROCUREMENT"), ...ro("SUPPLIERS"), ...ro("COSTING"),
    ...ro("REPORTS"),
  ],

  PROCUREMENT: [
    ...rw("INVENTORY"), ...all("PROCUREMENT"), ...all("SUPPLIERS"), ...ro("COSTING"),
    ...ro("PRICING"), ...ro("REPORTS"),
  ],

  FINANCE: [
    ...ro("ORDERS"), ...ro("INVENTORY"), ...ro("PROCUREMENT"),
    permission("PROCUREMENT", "APPROVE"), ...ro("SUPPLIERS"), ...ro("PRICING"),
    ...rw("COSTING"), ...all("FINANCE"), ...rw("REPORTS"), ...ro("AUDIT"),
  ],

  AUDITOR: READ_EVERYTHING,
};

export function permissionsForRoles(roles: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as Role] ?? []) out.add(p);
  return out;
}

export function roleHasPermission(role: Role, perm: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(perm);
}

export function rolesHavePermission(roles: readonly string[], perm: Permission): boolean {
  return permissionsForRoles(roles).has(perm);
}
