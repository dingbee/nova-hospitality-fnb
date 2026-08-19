/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Cost Intelligence Foundation.
 *
 * Closes the loop:
 *   recipe  →  inventory consumption  →  actual food cost  →  menu profitability
 *
 * Theoretical cost comes from the recipe costing captured on each order line at
 * the moment of sale. Actual cost comes from the consumption movements the sale
 * generated. The gap between them is the variance operators actually manage:
 * over-portioning, wastage and price drift.
 */
import { z } from "zod";
import type { ProfitabilityInput, listProfitabilitySchema } from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";

type Sb = any;

export interface ProfitabilityRow {
  menu_item_id: string | null;
  menu_item_name: string;
  quantity_sold: number;
  revenue: number;
  theoretical_cost: number;
  actual_cost: number;
  variance: number;
  gross_profit: number;
  margin_percent: number | null;
  food_cost_percent: number | null;
  currency: string;
}

export async function computeProfitability(
  sb: Sb,
  userId: string,
  input: ProfitabilityInput,
): Promise<{ periodStart: string; periodEnd: string; rows: ProfitabilityRow[]; totals: Omit<ProfitabilityRow, "menu_item_id" | "menu_item_name"> }> {
  await assertCapability(sb, userId, input.tenantId, "profitability.manage");

  let orderQuery = sb
    .from("restaurant_orders")
    .select("id, currency")
    .eq("tenant_id", input.tenantId)
    .eq("status", "closed")
    .gte("opened_at", input.from)
    .lte("opened_at", input.to);
  if (input.locationId) orderQuery = orderQuery.eq("location_id", input.locationId);
  if (input.propertyId) orderQuery = orderQuery.eq("property_id", input.propertyId);
  const { data: orders, error: orderErr } = await orderQuery;
  if (orderErr) throw new Error(orderErr.message);

  const orderIds = ((orders ?? []) as any[]).map((o) => o.id);
  const currency = ((orders ?? []) as any[])[0]?.currency ?? "TZS";
  if (orderIds.length === 0) {
    return {
      periodStart: input.from,
      periodEnd: input.to,
      rows: [],
      totals: {
        quantity_sold: 0,
        revenue: 0,
        theoretical_cost: 0,
        actual_cost: 0,
        variance: 0,
        gross_profit: 0,
        margin_percent: null,
        food_cost_percent: null,
        currency,
      },
    };
  }

  const [{ data: items }, { data: movements }] = await Promise.all([
    sb
      .from("restaurant_order_items")
      .select("id, menu_item_id, description, quantity, line_total, line_cost, status")
      .eq("tenant_id", input.tenantId)
      .in("order_id", orderIds),
    sb
      .from("restaurant_stock_movements")
      .select("order_item_id, total_cost")
      .eq("tenant_id", input.tenantId)
      .eq("movement_type", "consumption")
      .in("reference_id", orderIds),
  ]);

  // Actual cost is attributed back to the exact order line that consumed it.
  const actualByItem = new Map<string, number>();
  for (const m of ((movements ?? []) as any[])) {
    if (!m.order_item_id) continue;
    actualByItem.set(m.order_item_id, (actualByItem.get(m.order_item_id) ?? 0) + Number(m.total_cost ?? 0));
  }

  const agg = new Map<string, ProfitabilityRow>();
  for (const item of ((items ?? []) as any[]).filter((i) => i.status !== "voided")) {
    const key = item.menu_item_id ?? `adhoc:${item.description}`;
    const row =
      agg.get(key) ??
      ({
        menu_item_id: item.menu_item_id ?? null,
        menu_item_name: item.description,
        quantity_sold: 0,
        revenue: 0,
        theoretical_cost: 0,
        actual_cost: 0,
        variance: 0,
        gross_profit: 0,
        margin_percent: null,
        food_cost_percent: null,
        currency,
      } satisfies ProfitabilityRow);

    row.quantity_sold += Number(item.quantity ?? 0);
    row.revenue += Number(item.line_total ?? 0);
    row.theoretical_cost += Number(item.line_cost ?? 0);
    row.actual_cost += actualByItem.get(item.id) ?? Number(item.line_cost ?? 0);
    agg.set(key, row);
  }

  const rows = [...agg.values()]
    .map((r) => {
      const revenue = Number(r.revenue.toFixed(2));
      const actual = Number(r.actual_cost.toFixed(4));
      const theoretical = Number(r.theoretical_cost.toFixed(4));
      const grossProfit = Number((revenue - actual).toFixed(4));
      return {
        ...r,
        revenue,
        actual_cost: actual,
        theoretical_cost: theoretical,
        variance: Number((actual - theoretical).toFixed(4)),
        gross_profit: grossProfit,
        margin_percent: revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : null,
        food_cost_percent: revenue > 0 ? Number(((actual / revenue) * 100).toFixed(2)) : null,
        quantity_sold: Number(r.quantity_sold.toFixed(3)),
      };
    })
    .sort((a, b) => b.gross_profit - a.gross_profit)
    .slice(0, input.limit);

  const revenue = Number(rows.reduce((s, r) => s + r.revenue, 0).toFixed(2));
  const actual = Number(rows.reduce((s, r) => s + r.actual_cost, 0).toFixed(4));
  const theoretical = Number(rows.reduce((s, r) => s + r.theoretical_cost, 0).toFixed(4));
  const totals = {
    quantity_sold: Number(rows.reduce((s, r) => s + r.quantity_sold, 0).toFixed(3)),
    revenue,
    theoretical_cost: theoretical,
    actual_cost: actual,
    variance: Number((actual - theoretical).toFixed(4)),
    gross_profit: Number((revenue - actual).toFixed(4)),
    margin_percent: revenue > 0 ? Number((((revenue - actual) / revenue) * 100).toFixed(2)) : null,
    food_cost_percent: revenue > 0 ? Number(((actual / revenue) * 100).toFixed(2)) : null,
    currency,
  };

  if (input.persist && rows.length > 0) {
    const { error } = await sb.from("restaurant_profitability_snapshots").insert(
      rows.map((r) => ({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        location_id: input.locationId ?? null,
        menu_item_id: r.menu_item_id,
        menu_item_name: r.menu_item_name,
        period_start: input.from.slice(0, 10),
        period_end: input.to.slice(0, 10),
        quantity_sold: r.quantity_sold,
        revenue: r.revenue,
        theoretical_cost: r.theoretical_cost,
        actual_cost: r.actual_cost,
        variance: r.variance,
        gross_profit: r.gross_profit,
        margin_percent: r.margin_percent,
        food_cost_percent: r.food_cost_percent,
        currency: r.currency,
      })),
    );
    if (error) throw new Error(error.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.profitability.computed",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_tenant",
    entityId: input.tenantId,
    source: "restaurant-os",
    payload: {
      period_start: input.from.slice(0, 10),
      period_end: input.to.slice(0, 10),
      items: rows.length,
      revenue: totals.revenue,
      actual_cost: totals.actual_cost,
      variance: totals.variance,
      food_cost_percent: totals.food_cost_percent,
    },
  });

  return { periodStart: input.from, periodEnd: input.to, rows, totals };
}

export async function listProfitability(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listProfitabilitySchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_profitability_snapshots")
    .select(
      "id, menu_item_id, menu_item_name, period_start, period_end, quantity_sold, revenue, theoretical_cost, actual_cost, variance, gross_profit, margin_percent, food_cost_percent, currency, computed_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("computed_at", { ascending: false })
    .limit(input.limit);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}
