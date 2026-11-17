/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * The single seam between Restaurant OS and the Intelligence Core.
 *
 * Restaurant OS never reasons. It emits canonical facts; the core observes.
 * Emission is best-effort: a failure to observe must never fail a restaurant
 * write (e.g. a chef without platform intelligence roles updating a menu).
 */
import {
  restaurantDedupeKey,
  RESTAURANT_EVENT_SEVERITY,
  type RestaurantEventInput,
} from "./contracts";

type Sb = any;

/**
 * A boundary rejection (wrong tenant, unregistered module, RLS denial) is an
 * expected non-blocking outcome — it usually reflects a real authorization
 * question, not broken code. Anything else (a constraint violation, a
 * missing column, a connection failure) means something is actually wrong
 * and deserves a louder signal, even though it still must never fail the
 * restaurant write that triggered it.
 */
function isExpectedObserveRejection(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "42501") return true; // insufficient_privilege — an RLS/role boundary, not a bug
  if (err instanceof Error) {
    return /no tenant scope authorization is registered|do not belong to this restaurant tenant|forbidden/i.test(
      err.message,
    );
  }
  return false;
}

export async function emitRestaurantEvent(
  supabase: Sb,
  userId: string,
  input: RestaurantEventInput,
): Promise<{ delivered: boolean; duplicate: boolean; reason?: string }> {
  const { recordEvent } = await import("@/modules/intelligence/events/events.server");
  try {
    const res = await recordEvent(supabase, userId, {
      module: "restaurant",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.locationId,
      eventType: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: RESTAURANT_EVENT_SEVERITY[input.type],
      source: input.source,
      payload: input.payload,
      correlationId: input.correlationId,
      dedupeKey: restaurantDedupeKey(input),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    });
    return { delivered: true, duplicate: Boolean(res.duplicate) };
  } catch (err) {
    if (isExpectedObserveRejection(err)) {
      console.warn("[restaurant-os] event not observed", input.type, err);
    } else {
      console.error(
        "[restaurant-os] event not observed — possible implementation defect",
        input.type,
        err,
      );
    }
    return { delivered: false, duplicate: false, reason: (err as Error).message };
  }
}
