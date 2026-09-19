/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5.11 — inventory → menu opportunity detection.
 * Advisory only: it proposes, never writes to menus, pricing or stock.
 */
import { assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  coverRatio,
  daysUntil,
  deriveConfidence,
  derivePriority,
  summariseOpportunities,
  type Evidence,
  type Opportunity,
} from "./opportunities";

type Sb = any;
const DAY = 864e5;

export interface OpportunityInput {
  tenantId: string;
  locationId?: string;
  windowDays: number;
  targetCoverDays: number;
}

export async function getInventoryMenuOpportunities(sb: Sb, userId: string, input: OpportunityInput) {
  const { tenantId, windowDays, targetCoverDays } = input;
  await assertTenantRead(sb, userId, tenantId);
  const since = new Date(Date.now() - windowDays * DAY).toISOString();

  const [invRes, batchRes, movRes, itemsRes, orderRes, recipeRes, lineRes] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, par_level, reorder_point, average_cost, currency, status, location_id")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_inventory_batches")
      .select("inventory_item_id, quantity, expiry_date")
      .eq("tenant_id", tenantId)
      .not("expiry_date", "is", null),
    sb
      .from("restaurant_stock_movements")
      .select("inventory_item_id, quantity, movement_type, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since),
    sb
      .from("restaurant_menu_items")
      .select("id, name, price, currency, lifecycle_status")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_order_items")
      .select("menu_item_id, quantity, line_total, line_cost, status, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since),
    sb.from("restaurant_recipes").select("id, name, status, updated_at").eq("tenant_id", tenantId),
    sb
      .from("restaurant_recipe_lines")
      .select("recipe_id, inventory_item_id, quantity")
      .eq("tenant_id", tenantId),
  ]);

  const inventory = ((invRes.data ?? []) as any[]).filter(
    (i) => !input.locationId || i.location_id === input.locationId,
  );
  const currency = inventory[0]?.currency ?? "TZS";

  /* Consumption velocity per ingredient, from the ledger only. */
  const consumed = new Map<string, number>();
  for (const m of (movRes.data ?? []) as any[]) {
    const q = Math.abs(Number(m.quantity ?? 0));
    if (Number(m.quantity ?? 0) >= 0) continue; // issues/consumption are negative
    consumed.set(m.inventory_item_id, (consumed.get(m.inventory_item_id) ?? 0) + q);
  }
  const velocity = (id: string) => (consumed.get(id) ?? 0) / windowDays;

  /* Earliest expiry per ingredient. */
  const earliestExpiry = new Map<string, { date: string; quantity: number }>();
  for (const b of (batchRes.data ?? []) as any[]) {
    if (Number(b.quantity ?? 0) <= 0) continue;
    const prev = earliestExpiry.get(b.inventory_item_id);
    if (!prev || b.expiry_date < prev.date) {
      earliestExpiry.set(b.inventory_item_id, { date: b.expiry_date, quantity: Number(b.quantity) });
    }
  }

  /* Which recipes use which ingredient, and how those dishes are selling. */
  const recipesByIngredient = new Map<string, Set<string>>();
  for (const l of (lineRes.data ?? []) as any[]) {
    if (!l.inventory_item_id) continue;
    const set = recipesByIngredient.get(l.inventory_item_id) ?? new Set<string>();
    set.add(l.recipe_id);
    recipesByIngredient.set(l.inventory_item_id, set);
  }
  const soldByMenuItem = new Map<string, { qty: number; revenue: number; cost: number }>();
  for (const l of (orderRes.data ?? []) as any[]) {
    if (!l.menu_item_id || l.status === "voided") continue;
    const agg = soldByMenuItem.get(l.menu_item_id) ?? { qty: 0, revenue: 0, cost: 0 };
    agg.qty += Number(l.quantity ?? 0);
    agg.revenue += Number(l.line_total ?? 0);
    agg.cost += Number(l.line_cost ?? 0);
    soldByMenuItem.set(l.menu_item_id, agg);
  }

  const opportunities: Opportunity[] = [];

  for (const item of inventory) {
    const qty = Number(item.current_quantity ?? 0);
    if (qty <= 0) continue;
    const v = velocity(item.id);
    const cover = coverRatio(qty, v, targetCoverDays);
    const expiry = earliestExpiry.get(item.id) ?? null;
    const expiryDays = daysUntil(expiry?.date ?? null);
    const value = qty * Number(item.average_cost ?? 0);
    const linkedRecipes = recipesByIngredient.get(item.id)?.size ?? 0;

    const baseEvidence: Evidence[] = [
      { label: "Stock on hand", value: `${qty}`, strength: "hard", weight: 3 },
      {
        label: "Consumption velocity",
        value: v > 0 ? `${v.toFixed(2)}/day` : "no recorded consumption",
        strength: v > 0 ? "hard" : "missing",
        weight: 3,
      },
      {
        label: "Stock value",
        value: Number(item.average_cost ?? 0) > 0 ? `${currency} ${Math.round(value).toLocaleString()}` : "no cost on file",
        strength: Number(item.average_cost ?? 0) > 0 ? "hard" : "missing",
        weight: 2,
      },
      {
        label: "Menu linkage",
        value: linkedRecipes > 0 ? `${linkedRecipes} recipe(s)` : "not used by any recipe",
        strength: linkedRecipes > 0 ? "hard" : "missing",
        weight: 2,
      },
    ];

    if (expiryDays != null && expiryDays <= 14) {
      const evidence: Evidence[] = [
        ...baseEvidence,
        { label: "Earliest expiry", value: `${expiryDays} day(s)`, strength: "hard", weight: 4 },
      ];
      const blockers = linkedRecipes === 0 ? ["No recipe uses this ingredient yet"] : [];
      const confidence = deriveConfidence(evidence);
      opportunities.push({
        key: `opportunity.expiry.${item.id}`,
        kind: "expiry_risk",
        title: `${item.name} expires in ${expiryDays} day(s)`,
        summary: `${qty} on hand with the earliest batch expiring in ${expiryDays} day(s). Consider a special, a staff meal or a prep-ahead production run.`,
        entityType: "restaurant_inventory_item",
        entityId: item.id,
        evidence,
        confidence,
        priority: derivePriority("expiry_risk", confidence, expiryDays, blockers),
        blockers,
      });
      continue;
    }

    if (cover != null && cover >= 2) {
      const evidence: Evidence[] = [
        ...baseEvidence,
        { label: "Cover", value: `${cover}× the ${targetCoverDays}-day target`, strength: "hard", weight: 4 },
      ];
      const blockers = linkedRecipes === 0 ? ["No recipe uses this ingredient yet"] : [];
      const confidence = deriveConfidence(evidence);
      opportunities.push({
        key: `opportunity.overstock.${item.id}`,
        kind: "overstock",
        title: `${item.name} is overstocked`,
        summary: `Stock covers ${cover}× the ${targetCoverDays}-day target at current consumption. A feature dish would convert it into revenue.`,
        entityType: "restaurant_inventory_item",
        entityId: item.id,
        evidence,
        confidence,
        priority: derivePriority("overstock", confidence, null, blockers),
        blockers,
      });
      continue;
    }

    if (v === 0 && value > 0) {
      const evidence = baseEvidence;
      const blockers = linkedRecipes === 0 ? ["No recipe uses this ingredient yet"] : [];
      const confidence = deriveConfidence(evidence);
      opportunities.push({
        key: `opportunity.underutilised.${item.id}`,
        kind: "underutilised",
        title: `${item.name} has not moved in ${windowDays} days`,
        summary:
          linkedRecipes === 0
            ? `Held stock with no recipe linkage. Either build a dish around it or stop reordering.`
            : `Linked to ${linkedRecipes} recipe(s) but unused in the last ${windowDays} days.`,
        entityType: "restaurant_inventory_item",
        entityId: item.id,
        evidence,
        confidence,
        priority: derivePriority("underutilised", confidence, null, blockers),
        blockers,
      });
    }
  }

  /* Dormant recipes: costed and ready but nothing sells against them. */
  const menuItems = (itemsRes.data ?? []) as any[];
  for (const r of (recipeRes.data ?? []) as any[]) {
    if (r.status !== "active") continue;
    const used = (lineRes.data ?? []).some((l: any) => l.recipe_id === r.id);
    if (!used) continue;
    const anySales = menuItems.some((mi) => (soldByMenuItem.get(mi.id)?.qty ?? 0) > 0 && mi.name === r.name);
    if (anySales) continue;
    const evidence: Evidence[] = [
      { label: "Recipe status", value: "active", strength: "hard", weight: 2 },
      { label: "Sales in window", value: "none recorded", strength: "hard", weight: 3 },
      { label: "Menu placement", value: "not matched to a selling menu item", strength: "soft", weight: 2 },
    ];
    const confidence = deriveConfidence(evidence);
    opportunities.push({
      key: `opportunity.recipe.${r.id}`,
      kind: "recipe",
      title: `${r.name} is ready but not selling`,
      summary: `The recipe is active and costed, yet no sales were recorded in the last ${windowDays} days. Place it on a menu or retire it.`,
      entityType: "restaurant_recipe",
      entityId: r.id,
      evidence,
      confidence,
      priority: derivePriority("recipe", confidence, null, []),
      blockers: [],
    });
  }

  /* Margin opportunities on items that sell well but earn little. */
  for (const mi of menuItems) {
    const agg = soldByMenuItem.get(mi.id);
    if (!agg || agg.qty <= 0 || agg.revenue <= 0) continue;
    const margin = ((agg.revenue - agg.cost) / agg.revenue) * 100;
    if (margin >= 55 || agg.cost <= 0) continue;
    const evidence: Evidence[] = [
      { label: "Units sold", value: `${agg.qty}`, strength: "hard", weight: 3 },
      { label: "Margin", value: `${margin.toFixed(1)}%`, strength: "hard", weight: 4 },
      { label: "Recorded cost", value: `${currency} ${Math.round(agg.cost).toLocaleString()}`, strength: "hard", weight: 2 },
    ];
    const confidence = deriveConfidence(evidence);
    opportunities.push({
      key: `opportunity.margin.${mi.id}`,
      kind: "margin",
      title: `${mi.name} sells at ${margin.toFixed(1)}% margin`,
      summary: `${agg.qty} sold in ${windowDays} days at a below-target margin. Re-price, re-portion or re-engineer the recipe.`,
      entityType: "restaurant_menu_item",
      entityId: mi.id,
      evidence,
      confidence,
      priority: derivePriority("margin", confidence, null, []),
      blockers: mi.lifecycle_status === "active" ? [] : ["Item is not active"],
    });
  }

  opportunities.sort((a, b) => b.priority - a.priority);
  const top = opportunities.slice(0, 40);

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    summary: summariseOpportunities(top),
    opportunities: top,
  };
}

/** Publish the strongest findings as canonical events for the Intelligence Core. */
export async function publishOpportunityEvents(sb: Sb, userId: string, input: OpportunityInput) {
  const result = await getInventoryMenuOpportunities(sb, userId, input);
  const day = new Date().toISOString().slice(0, 10);
  const strong = result.opportunities.filter((o) => o.confidence != null && o.priority >= 60).slice(0, 10);
  for (const o of strong) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.menu.opportunity.detected",
      tenantId: input.tenantId,
      locationId: input.locationId,
      entityType: o.entityType,
      entityId: o.entityId ?? undefined,
      source: "restaurant-intelligence",
      payload: {
        kind: o.kind,
        title: o.title,
        summary: o.summary,
        confidence: o.confidence,
        priority: o.priority,
        blockers: o.blockers,
        evidence: o.evidence,
      },
      dedupeKey: `${o.key}:${day}`,
    });
  }
  return { published: strong.length, ...result };
}