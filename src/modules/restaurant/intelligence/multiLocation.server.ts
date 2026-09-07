/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §12 — Multi-Location Command (Pro/secondary).
 *
 * Cross-OUTLET visibility within the properties the caller can already see —
 * distinct from `multi_property_command` (P01, cross-PROPERTY), per the
 * master prompt's explicit "do not confuse multi-property with
 * multi-location" instruction. Reuses the existing property/location scope
 * model (`getTenantScope`/`accessibleLocationIds`) rather than inventing a
 * second one, and reuses `getInventoryIntelligence` per location for stock
 * risk rather than re-deriving it.
 *
 * Deliberately builds its own light per-location revenue/order query
 * instead of calling revenue.server.ts's gated `getRevenueIntelligence` N
 * times (which is gated on the sibling "revenue_intelligence" capability
 * and would be needlessly heavy run once per location) — this keeps the
 * capability self-sufficient and bounded.
 */
import { accessibleLocationIds, assertTenantRead, getTenantScope } from "../core/access.server";
import { getInventoryIntelligence } from "./inventory.server";
import { round } from "./analysis";
import type { RestaurantInsight } from "./types";
import type { LocationSummary, MultiLocationIntelligence } from "./p05.types";

type Sb = any;
const DAY = 864e5;
/** Bounded so this capability can never fan out an unbounded number of parallel per-location queries. */
const MAX_LOCATIONS = 15;

export interface MultiLocationInput {
  tenantId: string;
  windowDays: number;
  propertyId?: string | null;
}

export async function getMultiLocationIntelligence(
  sb: Sb,
  userId: string,
  input: MultiLocationInput,
): Promise<MultiLocationIntelligence> {
  const { tenantId, windowDays } = input;
  const scope = await getTenantScope(sb, userId, tenantId);
  await assertTenantRead(sb, userId, tenantId, { propertyId: input.propertyId ?? null });

  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  // Hard gate, not a soft narrowing: multi-location visibility across
  // outlets IS this capability — there is no safe, narrower fallback to
  // degrade to (unlike resolveMultiPropertyScope's single-property
  // fallback), so a non-entitled caller is denied outright.
  await assertEntitled(sb, tenantId, "multi_location_command", {
    propertyId: input.propertyId ?? null,
  });

  let locQuery = sb
    .from("restaurant_locations")
    .select("id, name, property_id")
    .eq("tenant_id", tenantId);
  if (input.propertyId) locQuery = locQuery.eq("property_id", input.propertyId);
  const { data: allLocations } = await locQuery;
  const allowedIds = await accessibleLocationIds(sb, scope);
  const locations = ((allLocations ?? []) as any[])
    .filter((l) => allowedIds === null || allowedIds.includes(l.id))
    .slice(0, MAX_LOCATIONS);

  if (locations.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      currency: "TZS",
      locations: [],
      bestPerforming: null,
      worstPerforming: null,
      insights: [
        {
          key: "multi_location.no_locations",
          severity: "info",
          title: "No accessible locations to compare",
          detail: "No outlets are visible under your current scope.",
        },
      ],
    };
  }

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const locationIds = locations.map((l) => l.id);

  const { data: orderRows } = await sb
    .from("restaurant_orders")
    .select("location_id, total, currency")
    .eq("tenant_id", tenantId)
    .eq("status", "closed")
    .neq("payment_state", "refunded")
    .gte("opened_at", start)
    .in("location_id", locationIds);

  const orders = (orderRows ?? []) as any[];
  const currency = orders[0]?.currency ?? "TZS";
  const revenueByLocation = new Map<string, { revenue: number; orders: number }>();
  for (const o of orders) {
    const cur = revenueByLocation.get(o.location_id) ?? { revenue: 0, orders: 0 };
    cur.revenue += Number(o.total ?? 0);
    cur.orders += 1;
    revenueByLocation.set(o.location_id, cur);
  }

  const summaries: LocationSummary[] = await Promise.all(
    locations.map(async (loc) => {
      const agg = revenueByLocation.get(loc.id) ?? { revenue: 0, orders: 0 };
      let topInsight: RestaurantInsight | null = null;
      let atRiskInventoryCount = 0;
      try {
        const inv = await getInventoryIntelligence(sb, userId, {
          tenantId,
          windowDays,
          locationId: loc.id,
        });
        atRiskInventoryCount = inv.atRisk.length;
        topInsight = inv.insights[0] ?? null;
      } catch {
        // A location this caller cannot read inventory for (should not
        // happen given accessibleLocationIds already filtered) simply
        // contributes no inventory signal rather than failing the whole
        // group view.
      }
      return {
        locationId: loc.id,
        name: loc.name,
        propertyId: loc.property_id ?? null,
        revenue: round(agg.revenue),
        orders: agg.orders,
        atRiskInventoryCount,
        topInsight,
      };
    }),
  );
  summaries.sort((a, b) => b.revenue - a.revenue);

  const insights: RestaurantInsight[] = [];
  if (summaries.length >= 2) {
    const best = summaries[0]!;
    const worst = summaries[summaries.length - 1]!;
    const avg = summaries.reduce((s, l) => s + l.revenue, 0) / summaries.length;
    if (avg > 0 && worst.revenue < avg * 0.5) {
      insights.push({
        key: `multi_location.underperformer.${worst.locationId}`,
        severity: "medium",
        title: `${worst.name} is materially underperforming the group's average`,
        detail: `${currency} ${worst.revenue.toLocaleString()} versus a group average of ${currency} ${round(avg).toLocaleString()}.`,
        recommendation:
          "Compare staffing, menu mix, and local demand against the top-performing outlet.",
      });
    }
    if (best.revenue > 0) {
      insights.push({
        key: `multi_location.top_performer.${best.locationId}`,
        severity: "info",
        title: `${best.name} is the group's top-performing outlet`,
        detail: `${currency} ${best.revenue.toLocaleString()} in revenue over the last ${windowDays} days.`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    locations: summaries,
    bestPerforming: summaries[0]?.locationId ?? null,
    worstPerforming: summaries.length > 0 ? summaries[summaries.length - 1]!.locationId : null,
    insights,
  };
}
