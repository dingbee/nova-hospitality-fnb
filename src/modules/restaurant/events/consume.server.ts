/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I9 — the first Intelligence event consumer.
 *
 * Closes the gap P10-I8 left open: intelligence_events were being written
 * (Observe) but nothing ever read them back to trigger a fresh Understand/
 * Reason pass. This is deliberately the smallest correct step, not an
 * event-sourced rewrite of the restaurant intelligence engines:
 *
 *   EVENT -> VALIDATE -> AUTHORIZE TENANT -> DEDUPE -> RECOMPUTE (existing
 *   engine) -> mark processed -> STOP.
 *
 * It never decides, approves, or executes anything — that boundary
 * (Decide -> Act -> Verify) is untouched; this file only ever calls the
 * existing, unmodified runRestaurantDecisionPass(), the same function the
 * Decisions page's "Run decision pass" button already calls by hand. The
 * restaurant_kitchen_tickets table remains the single source of truth for
 * kitchen state; intelligence_events is a trigger/context signal only.
 *
 * Scope (see the I9 audit in the accompanying report): of the ~130
 * canonical restaurant/bar event types, only restaurant.kitchen.ticket.
 * ready / .delayed are wired live here. Both are emitted exactly once per
 * ticket by kitchen.server.ts's advanceTicket(), deduped by a per-ticket
 * key (not time-bucketed), at the exact moment prep_seconds/is_delayed —
 * the fields getKitchenIntelligence() reads — are written.
 * restaurant.kitchen.ticket.fired is deliberately excluded: it fires
 * before prep_seconds exists, so it cannot itself change that
 * computation. Every other event family is classified in the audit but
 * intentionally left unwired — this consumer proves the architecture, it
 * does not attempt breadth.
 */
import { z } from "zod";
import { assertTenantRead } from "../core/access.server";
import { markEventsProcessed } from "@/modules/intelligence/events/events.server";
import { runRestaurantDecisionPass } from "../decisions/decisions.server";

type Sb = any;

/**
 * The only event types this consumer currently classifies as
 * "intelligence-relevant" (see the I9 audit for the full A-F
 * classification of the catalogue). Both change getKitchenIntelligence()'s
 * output directly; restaurant.kitchen.ticket.fired does not (see file doc
 * comment) and is not included.
 */
export const KITCHEN_COMPLETION_EVENT_TYPES = [
  "restaurant.kitchen.ticket.ready",
  "restaurant.kitchen.ticket.delayed",
] as const;

export const consumeRestaurantEventsSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
});
export type ConsumeRestaurantEventsInput = z.infer<typeof consumeRestaurantEventsSchema>;

export interface ConsumeRestaurantEventsResult {
  /** Number of unprocessed kitchen-completion events found (and, on success, marked processed). */
  consumed: number;
  /** True only when a recompute actually ran — never true for an empty batch. */
  refreshed: boolean;
  decisionsRecorded?: number;
  /** I10 — a still-`proposed` decision refreshed in place because its finding materially changed. */
  decisionsUpdated?: number;
  /** I10 — a still-`proposed` decision marked `expired` because its finding no longer appears. */
  decisionsExpired?: number;
  findings?: number;
  /**
   * Set only when the recompute itself failed. The batch is left exactly
   * as unprocessed as it was — no destructive reprocessing, safe retry on
   * the next invocation. This function never throws for a downstream
   * intelligence failure; ordinary restaurant operations must never be
   * made to depend on Intelligence processing succeeding.
   */
  failed?: boolean;
  failureReason?: string;
}

/**
 * Consumes unprocessed kitchen-ticket-completion events for one tenant and,
 * if any exist, triggers exactly one existing runRestaurantDecisionPass —
 * never one recompute per event. Idempotent: events are marked processed
 * only after the recompute has actually succeeded (act-then-mark), so a
 * thrown error leaves the same batch retryable rather than silently
 * dropped. Two concurrent callers can both do real recompute work in the
 * rare exact-tie case; the actual duplicate-decision guarantee for that
 * race is runRestaurantDecisionPass's own `unique (tenant_id, module,
 * decision_key)` constraint on intelligence_decisions (0011), not anything
 * in this function — a losing concurrent insert simply fails and is
 * skipped there, so no duplicate decision can result even from two
 * concurrent consumers.
 */
export async function consumeRestaurantEvents(
  sb: Sb,
  userId: string,
  input: ConsumeRestaurantEventsInput,
): Promise<ConsumeRestaurantEventsResult> {
  // Tenant authorization happens before a single row of intelligence_events
  // is read. The event's own tenant_id is never trusted on its own — this
  // is the explicit gate; restaurant_can_read RLS is the backstop, since
  // this always runs against the caller's own authenticated client, never
  // a service-role shortcut.
  await assertTenantRead(sb, userId, input.tenantId);

  const { data: events, error } = await sb
    .from("intelligence_events")
    .select("id, event_type, entity_id, occurred_at")
    .eq("tenant_id", input.tenantId)
    .eq("module", "restaurant")
    .in("event_type", KITCHEN_COMPLETION_EVENT_TYPES)
    .is("processed_at", null)
    .order("occurred_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);

  const unprocessed = (events ?? []) as Array<{ id: string }>;
  if (unprocessed.length === 0) {
    // Nothing changed since the last check — no recompute, no event
    // amplification. This is the common case: most requests to this
    // function should be this cheap.
    return { consumed: 0, refreshed: false };
  }

  let pass: {
    decisionsRecorded: number;
    decisionsUpdated: number;
    decisionsExpired: number;
    findings: number;
  };
  try {
    pass = await runRestaurantDecisionPass(sb, userId, {
      tenantId: input.tenantId,
      windowDays: input.windowDays,
      persist: true,
    });
  } catch (err) {
    // Recompute failed — leave every event unprocessed so the next
    // invocation retries the same batch. Never throw a business-operation
    // failure from a downstream Intelligence hiccup; the caller decides
    // whether to surface this, but the restaurant write that produced
    // these events already succeeded and is not rolled back.
    return {
      consumed: 0,
      refreshed: false,
      failed: true,
      failureReason: (err as Error).message,
    };
  }

  await markEventsProcessed(
    sb,
    unprocessed.map((e) => e.id),
  );

  return {
    consumed: unprocessed.length,
    refreshed: true,
    decisionsRecorded: pass.decisionsRecorded,
    decisionsUpdated: pass.decisionsUpdated,
    decisionsExpired: pass.decisionsExpired,
    findings: pass.findings,
  };
}
