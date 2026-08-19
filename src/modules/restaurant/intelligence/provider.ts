/**
 * Registers Restaurant & Bar OS with the existing Intelligence Core registry.
 * Registration is inert — it declares participation, it does not run anything.
 */
import { registerIntelligenceProvider } from "@/modules/intelligence/core/registry";
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
}

registerRestaurantIntelligence();