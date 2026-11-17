/**
 * Intelligence Core — access rules.
 *
 * There is exactly one role model in this product: the canonical RBAC model in
 * `@/lib/rbac/permissions`. Intelligence does not keep a second role store, a
 * second vocabulary, or an email/metadata shortcut — it expresses its needs as
 * canonical permissions and canonical role codes.
 */
import type { Role } from "@/lib/rbac/permissions";
import type { Permission } from "@/lib/rbac/permissions";
import type { IntelModule } from "./contracts";

/** Reading intelligence output is a reporting act. */
export const INTEL_READ_PERMISSION: Permission = "REPORTS:READ";

/** Accepting/dismissing a recommendation is an administrative act. */
export const INTEL_DECIDE_PERMISSION: Permission = "REPORTS:WRITE";

/** Canonical role code → intelligence modules that role may see. */
const ROLE_MODULES: Record<Role, readonly IntelModule[]> = {
  OWNER: ["pms", "booking", "guest", "revenue", "marketing", "restaurant", "operations", "finance", "content", "platform"],
  GENERAL_MANAGER: ["pms", "booking", "guest", "revenue", "marketing", "restaurant", "operations", "finance", "content"],
  RESTAURANT_MANAGER: ["restaurant", "operations", "guest", "revenue"],
  BAR_MANAGER: ["restaurant", "operations", "revenue"],
  CHEF: ["restaurant", "operations"],
  WAITER: ["restaurant", "guest"],
  BARTENDER: ["restaurant"],
  CASHIER: ["restaurant", "revenue"],
  STOREKEEPER: ["operations"],
  PROCUREMENT: ["operations", "finance"],
  FINANCE: ["finance", "revenue", "booking"],
  AUDITOR: ["pms", "booking", "guest", "revenue", "marketing", "restaurant", "operations", "finance", "content", "platform"],
};

export function allowedModulesForRoles(roles: readonly string[]): IntelModule[] {
  const set = new Set<IntelModule>();
  for (const r of roles) for (const m of ROLE_MODULES[r as Role] ?? []) set.add(m);
  return Array.from(set);
}

export function canSeeModule(roles: readonly string[], module: IntelModule): boolean {
  return allowedModulesForRoles(roles).includes(module);
}
