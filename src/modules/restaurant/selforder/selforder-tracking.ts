/**
 * Guest order-progress projection — a redacted, station-aware read over the
 * exact same facts lifecycle.ts's deriveLifecycle() and kitchen.server.ts's
 * listTickets already read: restaurant_order_items.status (only "ordered"
 * vs "fired"/"voided" matters here) and restaurant_kitchen_tickets.status
 * (the one restaurant_ticket_status enum in this schema — queued, preparing,
 * ready, served, cancelled). Nothing here is a second workflow: no new
 * status is written, and the two functions below only regroup rows the
 * canonical lifecycle already treats as authoritative.
 *
 * Pure and DB-free by design, matching selforder-cart.ts/selforder-recovery.ts
 * — the caller (selftrack.server.ts) fetches rows and an already-computed
 * deriveLifecycle() result; everything here is a plain data transform, unit
 * testable without a Supabase client.
 */
import { BAR_STATION_TYPES } from "../bar/contracts";
import type { LifecycleState } from "../sales/ui/lifecycle";

export type GuestProductionStage = "received" | "preparing" | "ready" | "served";

const STAGE_INDEX: Record<GuestProductionStage, number> = {
  received: 0,
  preparing: 1,
  ready: 2,
  served: 3,
};

export type GuestProductionStream = {
  station: "kitchen" | "bar";
  stage: GuestProductionStage;
};

export type TrackedItem = { status: string; stationType: string | null };
export type TrackedTicket = { status: string; stationType: string | null };

/** Same bar/non-bar split sendToStationLabel and resolveCataloguedLineStation already use — unassigned falls to "kitchen", never invented as a third lane. */
function lane(stationType: string | null): "kitchen" | "bar" {
  return stationType && (BAR_STATION_TYPES as readonly string[]).includes(stationType)
    ? "bar"
    : "kitchen";
}

const TICKET_STAGE: Partial<Record<string, GuestProductionStage>> = {
  queued: "preparing",
  preparing: "preparing",
  ready: "ready",
  served: "served",
};

/**
 * Groups an order's live items/tickets into a kitchen stream and/or a bar
 * stream, each given the *least advanced* stage among its own contributors
 * — a stream is never shown further along than its slowest ticket, so
 * "kitchen preparing, bar ready" and "one station served while the other is
 * still preparing" both come out correctly with no special-casing. A lane
 * this order never touched (no live item, no ticket) is omitted rather than
 * fabricated as "received".
 */
export function classifyGuestStreams(
  items: readonly TrackedItem[],
  tickets: readonly TrackedTicket[],
): GuestProductionStream[] {
  const best = new Map<"kitchen" | "bar", GuestProductionStage>();
  const consider = (station: "kitchen" | "bar", stage: GuestProductionStage) => {
    const current = best.get(station);
    if (!current || STAGE_INDEX[stage] < STAGE_INDEX[current]) best.set(station, stage);
  };

  for (const item of items) {
    // "fired"/"voided" items contribute nothing directly — once fired, the
    // ticket is the authoritative record of that line's progress; voided
    // lines were never produced.
    if (item.status === "ordered") consider(lane(item.stationType), "received");
  }
  for (const ticket of tickets) {
    const stage = TICKET_STAGE[ticket.status];
    if (stage) consider(lane(ticket.stationType), stage);
  }

  return (["kitchen", "bar"] as const)
    .filter((station) => best.has(station))
    .map((station) => ({ station, stage: best.get(station)! }));
}

export type GuestOverallStage = "received" | "preparing" | "ready" | "served" | "cancelled";

/**
 * The order-wide headline stage, read directly off deriveLifecycle()'s own
 * output — the same stage/nextAction the POS floor view already computes —
 * rather than recomputed from raw rows a second time. Everything from "the
 * bill was requested" onward collapses to "served": the food side of this
 * order is done, and the existing Request Bill / payment panels are the
 * guest's view into what happens next, not this one.
 */
export function classifyGuestOverallStage(
  orderStatus: string,
  life: LifecycleState,
): GuestOverallStage {
  // deriveLifecycle itself folds cancelled/voided into stage "closed",
  // identically to a normally-settled, receipt-delivered bill — called out
  // separately here from the same order.status field it already branches
  // on, so a guest is never told a cancelled order was "served".
  if (orderStatus === "cancelled" || orderStatus === "voided") return "cancelled";
  if (life.stage === "table" || life.stage === "order") return "received";
  if (life.stage === "production") return "preparing";
  if (life.stage === "service") return life.nextAction === "mark-served" ? "ready" : "served";
  return "served";
}
