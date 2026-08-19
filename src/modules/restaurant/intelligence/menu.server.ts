/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3.1 — Menu Intelligence.
 * Which dishes drive profit, which sell but lose margin, which are declining,
 * which to promote, and which recipes need a cost review.
 */
import { assertTenantRead } from "../core/access.server";
import { classifyMenuItem, median, percentChange, round } from "./analysis";
import type { MenuIntelligence, MenuItemIntelligence, RestaurantInsight } from "./types";

type Sb = any;

const DAY = 864e5;
const STALE_COST_DAYS = 90;
const COST_DRIFT_PERCENT = 15;

export async function getMenuIntelligence(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<MenuIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const prevStart = new Date(now - 2 * windowDays * DAY).toISOString();

  const [ordersRes, itemsRes, costsRes] = await Promise.all([
    sb
      .from("restaurant_orders")
      .select("id, closed_at, currency, status")
      .eq("tenant_id", tenantId)
      .gte("closed_at", prevStart)
      .not("closed_at", "is", null),
    sb.from("restaurant_menu_items").select("id, name, price, currency, cost_price").eq("tenant_id", tenantId),
    sb
      .from("restaurant_recipe_costs")
      .select("menu_item_id, total_cost, computed_at, food_cost_percent")
      .eq("tenant_id", tenantId),
  ]);

  const orders = ((ordersRes.data ?? []) as any[]).filter((o) => o.status !== "voided");
  const currency = (orders[0]?.currency as string) ?? "TZS";
  const currentIds = new Set(orders.filter((o) => o.closed_at >= start).map((o) => o.id));
  const previousIds = new Set(orders.filter((o) => o.closed_at < start).map((o) => o.id));

  const orderIds = orders.map((o) => o.id);
  const lines: any[] = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = orderIds.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data } = await sb
      .from("restaurant_order_items")
      .select("order_id, menu_item_id, description, quantity, line_total, line_cost, status")
      .eq("tenant_id", tenantId)
      .in("order_id", chunk);
    lines.push(...((data ?? []) as any[]));
  }

  const menuItems = (itemsRes.data ?? []) as any[];
  const costRows = (costsRes.data ?? []) as any[];
  const latestCost = new Map<string, any>();
  for (const c of costRows) {
    const prev = latestCost.get(c.menu_item_id);
    if (!prev || c.computed_at > prev.computed_at) latestCost.set(c.menu_item_id, c);
  }

  type Agg = { qty: number; revenue: number; cost: number; prevQty: number; name: string };
  const agg = new Map<string, Agg>();
  for (const l of lines) {
    if (l.status === "voided" || !l.menu_item_id) continue;
    const key = l.menu_item_id as string;
    const row =
      agg.get(key) ??
      ({ qty: 0, revenue: 0, cost: 0, prevQty: 0, name: l.description ?? "Item" } as Agg);
    const qty = Number(l.quantity ?? 0);
    if (currentIds.has(l.order_id)) {
      row.qty += qty;
      row.revenue += Number(l.line_total ?? 0);
      row.cost += Number(l.line_cost ?? 0);
    } else if (previousIds.has(l.order_id)) {
      row.prevQty += qty;
    }
    agg.set(key, row);
  }

  const items: MenuItemIntelligence[] = menuItems.map((mi) => {
    const a = agg.get(mi.id) ?? { qty: 0, revenue: 0, cost: 0, prevQty: 0, name: mi.name };
    const grossProfit = a.revenue - a.cost;
    const marginPercent = a.revenue > 0 ? round((grossProfit / a.revenue) * 100, 1) : null;
    const foodCostPercent = a.revenue > 0 ? round((a.cost / a.revenue) * 100, 1) : null;

    const recipe = latestCost.get(mi.id);
    const actualUnitCost = a.qty > 0 ? a.cost / a.qty : null;
    let costReviewReason: string | null = null;
    if (!recipe) {
      costReviewReason = "No recipe cost recorded";
    } else if (Date.now() - new Date(recipe.computed_at).getTime() > STALE_COST_DAYS * DAY) {
      costReviewReason = `Recipe cost last computed over ${STALE_COST_DAYS} days ago`;
    } else if (actualUnitCost != null && Number(recipe.total_cost) > 0) {
      const drift = ((actualUnitCost - Number(recipe.total_cost)) / Number(recipe.total_cost)) * 100;
      if (Math.abs(drift) >= COST_DRIFT_PERCENT) {
        costReviewReason = `Actual cost drifted ${round(drift, 1)}% from the recipe`;
      }
    }

    return {
      menuItemId: mi.id,
      name: mi.name,
      price: mi.price == null ? null : Number(mi.price),
      quantitySold: round(a.qty, 2),
      revenue: round(a.revenue),
      cost: round(a.cost),
      grossProfit: round(grossProfit),
      marginPercent,
      foodCostPercent,
      trendPercent: percentChange(a.qty, a.prevQty),
      classification: "unsold",
      needsCostReview: costReviewReason != null,
      costReviewReason,
      promote: false,
    };
  });

  const sold = items.filter((i) => i.quantitySold > 0);
  const medQty = median(sold.map((i) => i.quantitySold));
  const medMargin = median(sold.map((i) => i.marginPercent ?? 0));
  for (const i of items) {
    i.classification = classifyMenuItem(i.quantitySold, i.marginPercent, medQty, medMargin);
    // Promote: high margin but under-sold, or a star losing volume.
    i.promote =
      i.classification === "puzzle" ||
      (i.classification === "star" && (i.trendPercent ?? 0) < 0);
  }

  items.sort((a, b) => b.grossProfit - a.grossProfit);

  const profitDrivers = items.filter((i) => i.grossProfit > 0).slice(0, 8);
  const marginLosers = sold
    .filter((i) => (i.marginPercent ?? 100) < 45 || i.grossProfit <= 0)
    .sort((a, b) => (a.marginPercent ?? 0) - (b.marginPercent ?? 0))
    .slice(0, 8);
  const declining = sold
    .filter((i) => (i.trendPercent ?? 0) <= -20)
    .sort((a, b) => (a.trendPercent ?? 0) - (b.trendPercent ?? 0))
    .slice(0, 8);
  const promote = items.filter((i) => i.promote).slice(0, 8);
  const costReview = items.filter((i) => i.needsCostReview && (i.quantitySold > 0 || i.price != null)).slice(0, 12);

  const totals = sold.reduce(
    (acc, i) => ({
      revenue: acc.revenue + i.revenue,
      cost: acc.cost + i.cost,
      grossProfit: acc.grossProfit + i.grossProfit,
      itemsSold: acc.itemsSold + i.quantitySold,
    }),
    { revenue: 0, cost: 0, grossProfit: 0, itemsSold: 0 },
  );

  const insights: RestaurantInsight[] = [];
  if (profitDrivers[0]) {
    insights.push({
      key: "menu.top_driver",
      severity: "info",
      title: `${profitDrivers[0].name} is your strongest profit driver`,
      detail: `It generated ${currency} ${profitDrivers[0].grossProfit.toLocaleString()} gross profit from ${profitDrivers[0].quantitySold} sold in the last ${windowDays} days.`,
      metric: `${profitDrivers[0].marginPercent ?? 0}% margin`,
      recommendation: "Keep it visible: menu position, upsell script, and guaranteed availability.",
    });
  }
  for (const l of marginLosers.slice(0, 3)) {
    insights.push({
      key: `menu.margin_loss.${l.menuItemId}`,
      severity: (l.marginPercent ?? 0) < 25 ? "high" : "medium",
      title: `${l.name} sells but loses margin`,
      detail: `${l.quantitySold} sold at ${l.marginPercent ?? 0}% margin (${l.foodCostPercent ?? 0}% food cost).`,
      metric: `${l.foodCostPercent ?? 0}% food cost`,
      recommendation: "Re-price, re-portion, or re-engineer the recipe before pushing volume.",
    });
  }
  for (const d of declining.slice(0, 3)) {
    insights.push({
      key: `menu.declining.${d.menuItemId}`,
      severity: "medium",
      title: `${d.name} is declining`,
      detail: `Volume fell ${Math.abs(d.trendPercent ?? 0)}% versus the previous ${windowDays} days.`,
      metric: `${d.trendPercent ?? 0}%`,
      recommendation: "Check availability and prep quality, or retire the dish at the next menu change.",
    });
  }
  if (costReview.length > 0) {
    insights.push({
      key: "menu.cost_review",
      severity: costReview.length > 5 ? "high" : "medium",
      title: `${costReview.length} recipes need a cost review`,
      detail: costReview
        .slice(0, 4)
        .map((c) => `${c.name} — ${c.costReviewReason}`)
        .join("; "),
      recommendation: "Recompute recipe costs so pricing decisions use current ingredient prices.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    totals: {
      revenue: round(totals.revenue),
      cost: round(totals.cost),
      grossProfit: round(totals.grossProfit),
      itemsSold: round(totals.itemsSold, 2),
    },
    items: sold,
    profitDrivers,
    marginLosers,
    declining,
    promote,
    costReview,
    insights,
  };
}