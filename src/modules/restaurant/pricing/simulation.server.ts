/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial simulation. Preview only: it never writes a price. Managers see
 * the revenue and margin consequence of a change before committing to it.
 */
import { assertTenantRead } from "../core/access.server";
import type { SimulatePricingInput } from "./contracts";
import { loadRuleSet } from "./resolution.server";
import { resolveBasePrice } from "./engine";

type Sb = any;

export type SimulatedLine = {
  menuItemId: string;
  name: string;
  currentPrice: number;
  proposedPrice: number;
  unitCost: number;
  soldQuantity: number;
  currentRevenue: number;
  projectedRevenue: number;
  currentMargin: number;
  projectedMargin: number;
};

export async function simulatePricing(sb: Sb, userId: string, input: SimulatePricingInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  const since = new Date(Date.now() - input.lookbackDays * 86_400_000).toISOString();

  let itemsQuery = sb
    .from("restaurant_menu_items")
    .select("id, name, category_id, price")
    .eq("tenant_id", input.tenantId)
    .limit(400);
  if (input.menuItemIds.length > 0) itemsQuery = itemsQuery.in("id", input.menuItemIds);
  else if (input.categoryIds.length > 0)
    itemsQuery = itemsQuery.in("category_id", input.categoryIds);

  const { data: items } = await itemsQuery;
  const menuItems = (items ?? []) as any[];
  if (menuItems.length === 0) {
    return { lines: [], totals: emptyTotals(), assumptions: assumptions(input) };
  }
  const ids = menuItems.map((i) => i.id);

  const [{ data: sold }, rules] = await Promise.all([
    sb
      .from("restaurant_order_items")
      .select("menu_item_id, quantity, line_total, line_cost, created_at, status")
      .eq("tenant_id", input.tenantId)
      .in("menu_item_id", ids)
      .gte("created_at", since)
      .limit(5000),
    loadRuleSet(sb, input.tenantId, { menuItemIds: ids }),
  ]);

  const volume = new Map<string, { qty: number; revenue: number; cost: number }>();
  for (const row of (sold ?? []) as any[]) {
    if (row.status === "voided") continue;
    const agg = volume.get(row.menu_item_id) ?? { qty: 0, revenue: 0, cost: 0 };
    agg.qty += Number(row.quantity ?? 0);
    agg.revenue += Number(row.line_total ?? 0);
    agg.cost += Number(row.line_cost ?? 0);
    volume.set(row.menu_item_id, agg);
  }

  const at = new Date();
  const factor = 1 + input.changePercent / 100;
  // Illustrative elasticity: a price move shifts volume by elasticity × change.
  const volumeFactor = Math.max(0, 1 + (input.changePercent / 100) * input.elasticity);

  const lines: SimulatedLine[] = menuItems.map((item) => {
    const candidates = rules.prices.filter((p) => p.menuItemId === item.id);
    const resolved = resolveBasePrice(candidates, {
      at,
      propertyId: input.propertyId ?? null,
      locationId: input.locationId ?? null,
      menuItemId: item.id,
      categoryId: item.category_id ?? null,
      quantity: 1,
    });
    const currentPrice = resolved?.amount ?? Number(item.price ?? 0);
    const agg = volume.get(item.id) ?? { qty: 0, revenue: 0, cost: 0 };
    const unitCost = agg.qty > 0 ? agg.cost / agg.qty : 0;
    const proposedPrice = Number((currentPrice * factor).toFixed(2));
    const projectedQty = agg.qty * volumeFactor;
    const currentRevenue = agg.qty * currentPrice;
    const projectedRevenue = projectedQty * proposedPrice;
    return {
      menuItemId: item.id,
      name: item.name,
      currentPrice,
      proposedPrice,
      unitCost: Number(unitCost.toFixed(4)),
      soldQuantity: Number(agg.qty.toFixed(2)),
      currentRevenue: Number(currentRevenue.toFixed(2)),
      projectedRevenue: Number(projectedRevenue.toFixed(2)),
      currentMargin:
        currentPrice > 0
          ? Number((((currentPrice - unitCost) / currentPrice) * 100).toFixed(2))
          : 0,
      projectedMargin:
        proposedPrice > 0
          ? Number((((proposedPrice - unitCost) / proposedPrice) * 100).toFixed(2))
          : 0,
    };
  });

  const totals = lines.reduce(
    (t, l) => ({
      affectedProducts: t.affectedProducts + 1,
      currentRevenue: t.currentRevenue + l.currentRevenue,
      projectedRevenue: t.projectedRevenue + l.projectedRevenue,
      currentGrossProfit: t.currentGrossProfit + (l.currentPrice - l.unitCost) * l.soldQuantity,
      projectedGrossProfit:
        t.projectedGrossProfit + (l.proposedPrice - l.unitCost) * l.soldQuantity * volumeFactor,
    }),
    emptyTotals(),
  );

  return {
    lines: lines.sort((a, b) => b.currentRevenue - a.currentRevenue),
    totals: {
      ...totals,
      currentRevenue: Number(totals.currentRevenue.toFixed(2)),
      projectedRevenue: Number(totals.projectedRevenue.toFixed(2)),
      currentGrossProfit: Number(totals.currentGrossProfit.toFixed(2)),
      projectedGrossProfit: Number(totals.projectedGrossProfit.toFixed(2)),
      revenueDelta: Number((totals.projectedRevenue - totals.currentRevenue).toFixed(2)),
      grossProfitDelta: Number(
        (totals.projectedGrossProfit - totals.currentGrossProfit).toFixed(2),
      ),
    },
    assumptions: assumptions(input),
  };
}

function emptyTotals() {
  return {
    affectedProducts: 0,
    currentRevenue: 0,
    projectedRevenue: 0,
    currentGrossProfit: 0,
    projectedGrossProfit: 0,
  };
}

function assumptions(input: SimulatePricingInput) {
  return {
    changePercent: input.changePercent,
    elasticity: input.elasticity,
    lookbackDays: input.lookbackDays,
    note: "Preview only — no price is changed. Volume effect is illustrative, not a forecast.",
  };
}
