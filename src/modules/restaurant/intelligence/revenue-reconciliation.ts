/**
 * LB-04 cross-product revenue guard.
 *
 * StayNas is canonical for accommodation revenue; LexiBite is canonical for
 * food-and-beverage revenue. A room-charge settlement is counted only as the
 * LexiBite F&B event after LB-03 reconciliation, never again as StayNas F&B.
 * Totals remain partitioned by property and currency; no FX is performed.
 */
export type RevenueSource = "staynas" | "lexibite";
export type RevenueCategory = "accommodation" | "food_beverage";
export interface RevenueEvent {
  id: string;
  economicEventKey: string;
  propertyId: string;
  source: RevenueSource;
  category: RevenueCategory;
  currency: string;
  amount: number;
  state: "posted" | "pending" | "reversed";
  reconciliation: "reconciled" | "pending" | "disputed";
  reversesEventId?: string | null;
}
export interface RevenueTotal {
  propertyId: string;
  currency: string;
  accommodationRevenue: number;
  foodBeverageRevenue: number;
  combinedRevenue: number;
  eventCount: number;
}
export interface RevenueExclusion {
  eventId: string;
  reason: "invalid_amount_or_currency" | "not_posted" | "not_reconciled" |
    "non_canonical_source" | "reversed" | "duplicate_economic_event";
}
export interface RevenueAggregation {
  totals: RevenueTotal[];
  exclusions: RevenueExclusion[];
  reconciliationRequired: boolean;
}

export function aggregateReconciledRevenue(events: RevenueEvent[]): RevenueAggregation {
  const exclusions: RevenueExclusion[] = [];
  const eventIds = new Set(events.map((event) => event.id));
  const reversedIds = new Set(events.map((event) => event.reversesEventId).filter((id): id is string => Boolean(id)));
  let unmatchedReversal = false;
  const candidates: RevenueEvent[] = [];

  for (const event of events) {
    if (event.state === "reversed") {
      if (!event.reversesEventId || !eventIds.has(event.reversesEventId)) unmatchedReversal = true;
      exclusions.push({ eventId: event.id, reason: "reversed" });
    } else if (!/^[A-Z]{3}$/.test(event.currency) || !Number.isFinite(event.amount) || event.amount < 0) {
      exclusions.push({ eventId: event.id, reason: "invalid_amount_or_currency" });
    } else if (event.state !== "posted") {
      exclusions.push({ eventId: event.id, reason: "not_posted" });
    } else if (event.reconciliation !== "reconciled") {
      exclusions.push({ eventId: event.id, reason: "not_reconciled" });
    } else if (reversedIds.has(event.id)) {
      exclusions.push({ eventId: event.id, reason: "reversed" });
    } else if (
      (event.category === "accommodation" && event.source !== "staynas") ||
      (event.category === "food_beverage" && event.source !== "lexibite")
    ) {
      exclusions.push({ eventId: event.id, reason: "non_canonical_source" });
    } else {
      candidates.push(event);
    }
  }

  // Economic event keys are global across categories: a source event cannot
  // contribute once as accommodation and again as F&B.
  const byEconomicKey = new Map<string, RevenueEvent[]>();
  for (const event of candidates) {
    const key = [event.propertyId, event.currency, event.economicEventKey].join("|");
    const group = byEconomicKey.get(key) ?? [];
    group.push(event);
    byEconomicKey.set(key, group);
  }

  const accepted: RevenueEvent[] = [];
  let duplicateFound = false;
  for (const group of byEconomicKey.values()) {
    if (group.length > 1) {
      duplicateFound = true;
      for (const event of group) exclusions.push({ eventId: event.id, reason: "duplicate_economic_event" });
    } else if (group[0]) {
      accepted.push(group[0]);
    }
  }

  const totals = new Map<string, RevenueTotal>();
  for (const event of accepted) {
    const key = [event.propertyId, event.currency].join("|");
    const total = totals.get(key) ?? {
      propertyId: event.propertyId,
      currency: event.currency,
      accommodationRevenue: 0,
      foodBeverageRevenue: 0,
      combinedRevenue: 0,
      eventCount: 0,
    };
    if (event.category === "accommodation") total.accommodationRevenue += event.amount;
    else total.foodBeverageRevenue += event.amount;
    total.combinedRevenue = total.accommodationRevenue + total.foodBeverageRevenue;
    total.eventCount += 1;
    totals.set(key, total);
  }

  return {
    totals: [...totals.values()].sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.currency.localeCompare(b.currency)),
    exclusions,
    reconciliationRequired: unmatchedReversal || duplicateFound || exclusions.some((item) =>
      item.reason === "invalid_amount_or_currency" || item.reason === "not_posted" || item.reason === "not_reconciled"),
  };
}
