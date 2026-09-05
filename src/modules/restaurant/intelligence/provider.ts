/**
 * Registers Restaurant & Bar OS with the existing Intelligence Core registry.
 * Registration is inert — it declares participation, it does not run anything.
 */
import {
  registerIntelligenceProvider,
  registerTenantScopeChecker,
} from "@/modules/intelligence/core/registry";
import { assertTenantRead } from "../core/access.server";
import { RESTAURANT_EVENT_TYPES } from "../events/contracts";

export function registerRestaurantIntelligence(): void {
  registerIntelligenceProvider({
    module: "restaurant",
    label: "Restaurant & Bar OS",
    stages: ["observe", "understand", "reason", "recommend"],
    emits: RESTAURANT_EVENT_TYPES,
    handles: [
      "restaurant.purchase.suggest",
      "restaurant.menu.reprice_review",
      "restaurant.inventory.replenish_review",
      "restaurant.kitchen.workflow_review",
      "restaurant.kitchen.staffing_review",
      "restaurant.no_change",
    ],
  });

  // Restaurant intelligence records are scoped by restaurant_tenants/
  // restaurant_members (see decisions.server.ts's use of this same
  // assertTenantRead) — not the canonical tenants/rbac_user_roles model the
  // shell navigation uses. This is the one true check for "does this caller
  // belong to the tenant this restaurant intelligence_decisions row names."
  registerTenantScopeChecker("restaurant", (supabase, userId, scope) =>
    assertTenantRead(supabase, userId, scope.tenantId, {
      propertyId: scope.propertyId ?? null,
      locationId: scope.locationId ?? null,
    }),
  );
}

registerRestaurantIntelligence();
