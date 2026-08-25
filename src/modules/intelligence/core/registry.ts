/**
 * Intelligence provider registry.
 *
 * Modules declare how they participate in the loop. Registration is inert —
 * it does not run anything — so v1.0 behaviour is unchanged until a module
 * actually emits events.
 */
import type { IntelligenceProvider, IntelModule } from "./contracts";

const providers = new Map<IntelModule, IntelligenceProvider>();

export function registerIntelligenceProvider(provider: IntelligenceProvider): void {
  providers.set(provider.module, provider);
}

export function getIntelligenceProvider(module: IntelModule): IntelligenceProvider | undefined {
  return providers.get(module);
}

export function listIntelligenceProviders(): IntelligenceProvider[] {
  return Array.from(providers.values());
}

/**
 * Tenant/property/location authorization for a module's own records.
 *
 * The Intelligence Core spans modules with genuinely different tenant ID
 * spaces (e.g. restaurant/* scopes everything by restaurant_tenants + the
 * restaurant_members table, not the canonical tenants/rbac_user_roles model
 * the shell navigation uses) — there is no single scope check the core can
 * perform on a module's behalf. A module that wants its intelligence_*
 * records (decisions, plans, actions, ...) to be tenant-safe must register
 * how to verify a caller belongs to a given scope; callers that skip this
 * (see decision.server.ts) refuse to act rather than silently allow.
 */
export type TenantScopeChecker = (
  supabase: unknown,
  userId: string,
  scope: { tenantId: string; propertyId?: string | null; locationId?: string | null },
) => Promise<void>;

const tenantScopeCheckers = new Map<IntelModule, TenantScopeChecker>();

export function registerTenantScopeChecker(module: IntelModule, checker: TenantScopeChecker): void {
  tenantScopeCheckers.set(module, checker);
}

export function getTenantScopeChecker(module: IntelModule): TenantScopeChecker | undefined {
  return tenantScopeCheckers.get(module);
}

/**
 * Baseline registrations for modules that do not yet own a real
 * implementation to self-register from. A module that has grown one (see
 * restaurant/intelligence/provider.ts, imported from the restaurant admin
 * layout) registers itself and that registration is authoritative —
 * do not also declare it here, or the two silently race for whichever
 * imports last.
 */
registerIntelligenceProvider({
  module: "pms",
  label: "PMS / Rooms",
  stages: ["observe", "understand"],
  emits: ["room.state_changed", "room.occupied", "room.released"],
});
registerIntelligenceProvider({
  module: "booking",
  label: "Booking Engine",
  stages: ["observe", "understand", "reason"],
  emits: ["booking.created", "booking.cancelled", "booking.checked_in", "booking.checked_out"],
});
registerIntelligenceProvider({
  module: "guest",
  label: "Guest Intelligence",
  stages: ["observe", "understand", "reason", "recommend", "learn"],
  emits: ["guest.profile_updated", "guest.preference_detected", "guest.feedback_received"],
});
registerIntelligenceProvider({
  module: "revenue",
  label: "Revenue Intelligence",
  stages: ["understand", "reason", "recommend"],
  emits: ["revenue.rate_changed", "revenue.pace_shift"],
});
registerIntelligenceProvider({
  module: "marketing",
  label: "Marketing Intelligence",
  stages: ["understand", "reason", "recommend"],
  emits: ["marketing.campaign_sent", "marketing.channel_shift"],
});
