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

/** Baseline registrations for modules that already exist in Restaurant & Bar OS v1.0. */
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
registerIntelligenceProvider({
  module: "restaurant",
  label: "Restaurant OS",
  stages: ["observe"],
  emits: ["restaurant.order_placed", "restaurant.cover_seated"],
});