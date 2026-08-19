/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * The single seam between Restaurant OS and the Intelligence Core.
 *
 * Restaurant OS never reasons. It emits canonical facts; the core observes.
 * Emission is best-effort: a failure to observe must never fail a restaurant
 * write (e.g. a chef without platform intelligence roles updating a menu).
 */
import { restaurantDedupeKey, RESTAURANT_EVENT_SEVERITY, type RestaurantEventInput } from "./contracts";

type Sb = any;

export async function emitRestaurantEvent(
  supabase: Sb,
  userId: string,
  input: RestaurantEventInput,
): Promise<{ delivered: boolean; duplicate: boolean; reason?: string }> {
  const { recordEvent } = await import("@/modules/intelligence/events/events.server");
  try {
    const res = await recordEvent(supabase, userId, {
      module: "restaurant",
      eventType: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: RESTAURANT_EVENT_SEVERITY[input.type],
      source: input.source,
      payload: {
        ...input.payload,
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        location_id: input.locationId ?? null,
        actor_id: userId,
      },
      correlationId: input.correlationId,
      dedupeKey: restaurantDedupeKey(input),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    });
    return { delivered: true, duplicate: Boolean(res.duplicate) };
  } catch (err) {
    console.warn("[restaurant-os] event not observed", input.type, err);
    return { delivered: false, duplicate: false, reason: (err as Error).message };
  }
}