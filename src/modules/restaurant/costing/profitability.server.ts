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
import {
  accessibleLocationIds,
  assertCapability,
  assertTenantRead,
  getTenantScope,
  NO_MATCH_ID,
} from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { calculateOperationalProfitability } from "./operational-profitability.calculation";

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
  channel?: string;
  property_id?: string | null;
  location_id?: string | null;
}

export interface ProfitabilityTotals extends Omit<ProfitabilityRow, "menu_item_id" | "menu_item_name"> {
  allocated_operating_expenses: number;
  contribution_profit: number;
  contribution_margin_percent: number | null;
  operating_profit: number;
  operating_margin_percent: number | null;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax_collected: number;
  net_sales: number;
  service_consumables: number;
  other_direct_variable_costs: number;
  direct_variable_costs: number;
  unallocated_operating_expenses: number;
  confidence_state: string;
}

export async function computeProfitability(
  sb: Sb,
  userId: string,
  input: ProfitabilityInput,
): Promise<{
  periodStart: string;
  periodEnd: string;
  rows: ProfitabilityRow[];
  totals: ProfitabilityTotals;
  operational: ReturnType<typeof calculateOperationalProfitability>;
  dimensions: Array<{
    dimension_type: "channel" | "outlet" | "property";
    dimension_key: string;
    dimension_name: string;
    net_sales: number;
    direct_variable_costs: number;
    contribution: number;
    operating_profit: number;
  }>;
}> {
  await assertCapability(sb, userId, input.tenantId, "profitability.manage", {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });

  let orderQuery = sb
    .from("restaurant_orders")
    .select("id, currency, property_id, location_id, source, subtotal, discount_total, tax_total, service_charge")
    .eq("tenant_id", input.tenantId)
    .eq("status", "closed")
    .gte("opened_at", input.from)
    .lte("opened_at", input.to);
  if (input.locationId) orderQuery = orderQuery.eq("location_id", input.locationId);
  if (input.propertyId) orderQuery = orderQuery.eq("property_id", input.propertyId);
  const { data: orders, error: orderErr } = await orderQuery;
  if (orderErr) throw new Error(orderErr.message);

  const orderRows = (orders ?? []) as any[];
  if (orderRows.some((o) => !/^[A-Z]{3}$/.test(String(o.currency ?? "")))) {
    throw new Error("Sales source currency is missing or invalid.");
  }
  const orderIds = orderRows.map((o) => o.id);
  const orderCurrencies = new Set(orderRows.map((o) => o.currency));
  if (orderCurrencies.size > 1) throw new Error("Profitability cannot combine sales across currencies.");
  const periodFrom = input.from.slice(0, 10);
  const periodTo = input.to.slice(0, 10);
  let expenseAllocationQuery = sb
    .from("restaurant_cost_allocations")
    .select("amount, currency")
    .eq("tenant_id", input.tenantId)
    .eq("source_type", "operational_expense")
    .gte("period_start", periodFrom)
    .lte("period_start", periodTo);
  if (input.propertyId) expenseAllocationQuery = expenseAllocationQuery.eq("property_id", input.propertyId);
  if (input.locationId) expenseAllocationQuery = expenseAllocationQuery.eq("location_id", input.locationId);
  const { data: expenseAllocations, error: expenseAllocationError } = await expenseAllocationQuery;
  if (expenseAllocationError) throw new Error(expenseAllocationError.message);
  const allocationRows = (expenseAllocations ?? []) as any[];
  if (allocationRows.some((r) => !/^[A-Z]{3}$/.test(String(r.currency ?? "")))) {
    throw new Error("Allocated operating cost currency is missing or invalid.");
  }
  const currencies = new Set(allocationRows.map((r) => r.currency));
  const currencySet = new Set([...orderCurrencies, ...currencies]);
  if (currencySet.size > 1) throw new Error("Profitability cannot combine sales and operating costs across currencies.");
  let currency = [...currencySet][0];
  if (!currency) {
    if (input.propertyId) {
      const { data: property, error: propertyError } = await sb
        .from("restaurant_properties")
        .select("currency")
        .eq("tenant_id", input.tenantId)
        .eq("id", input.propertyId)
        .single();
      if (propertyError || !/^[A-Z]{3}$/.test(String(property?.currency ?? ""))) {
        throw new Error("A valid property reporting currency is required.");
      }
      currency = property.currency;
    } else if (input.locationId) {
      const { data: location, error: locationError } = await sb
        .from("restaurant_locations")
        .select("property_id")
        .eq("tenant_id", input.tenantId)
        .eq("id", input.locationId)
        .single();
      if (locationError || !location?.property_id) {
        throw new Error("A valid property reporting currency is required.");
      }
      const { data: property, error: propertyError } = await sb
        .from("restaurant_properties")
        .select("currency")
        .eq("tenant_id", input.tenantId)
        .eq("id", location.property_id)
        .single();
      if (propertyError || !/^[A-Z]{3}$/.test(String(property?.currency ?? ""))) {
        throw new Error("A valid property reporting currency is required.");
      }
      currency = property.currency;
    } else {
      const { data: properties, error: propertyError } = await sb
        .from("restaurant_properties")
        .select("currency")
        .eq("tenant_id", input.tenantId);
      if (propertyError) throw new Error(propertyError.message);
      const propertyCurrencies = new Set(
        ((properties ?? []) as any[]).map((p) => p.currency).filter((v) => /^[A-Z]{3}$/.test(String(v))),
      );
      if (propertyCurrencies.size !== 1) {
        throw new Error("A single property reporting currency is required for a tenant-wide profitability report.");
      }
      currency = [...propertyCurrencies][0];
    }
  }
  if (!/^[A-Z]{3}$/.test(String(currency))) {
    throw new Error("A valid property reporting currency is required.");
  }
  const allocatedOperatingExpenses = Number(
    allocationRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0).toFixed(2),
  );
  if (orderIds.length === 0) {
    return {
      periodStart: input.from,
      periodEnd: input.to,
      rows: [],
      totals: {
        quantity_sold: 0, revenue: 0, theoretical_cost: 0, actual_cost: 0, variance: 0,
        gross_profit: 0, margin_percent: null, food_cost_percent: null,
        allocated_operating_expenses: allocatedOperatingExpenses,
        contribution_profit: 0, contribution_margin_percent: null,
        operating_profit: Number((-allocatedOperatingExpenses).toFixed(2)), operating_margin_percent: null,
        currency, gross_sales: 0, discounts: 0, refunds: 0, tax_collected: 0, net_sales: 0,
        service_consumables: 0, other_direct_variable_costs: 0, direct_variable_costs: 0,
        unallocated_operating_expenses: 0, confidence_state: "incomplete_source_data",
      },
      operational: calculateOperationalProfitability({
        currency, grossSales: 0, discounts: 0, refunds: 0, salesAdjustments: 0, taxCollected: 0,
        recipeCogs: 0, recipeCostBasis: "standard", serviceConsumables: 0,
        consumablesCostBasis: "estimated", otherDirectVariableCosts: 0,
        allocatedOperatingExpenses, unallocatedOperatingExpenses: 0,
        pendingExpenseVerification: false, incompleteSourceData: true,
      }),
      dimensions: [],
    };
  }

  const [{ data: items, error: itemError }, { data: movements, error: movementError }, { data: payments, error: paymentError }, { data: unallocated, error: unallocatedError }, { data: pendingExpenses, error: pendingExpenseError }] = await Promise.all([
    sb.from("restaurant_order_items")
      .select("id, order_id, menu_item_id, description, quantity, line_total, line_cost, discount, tax_amount, service_charge_amount, status, is_comp, channel")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    sb.from("restaurant_stock_movements")
      .select("id, order_item_id, total_cost, currency, reference_id")
      .eq("tenant_id", input.tenantId).eq("movement_type", "consumption")
      .in("reference_id", orderIds),
    sb.from("restaurant_payments")
      .select("id, order_id, amount, state, refund_of, currency")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    sb.from("restaurant_cost_allocation_exceptions")
      .select("id, source_id, source_amount, currency, property_id")
      .eq("tenant_id", input.tenantId).gte("period_start", periodFrom).lte("period_start", periodTo),
    sb.from("restaurant_operational_expenses")
      .select("id, amount, currency, approval_status, property_id, location_id")
      .eq("tenant_id", input.tenantId).gte("incurred_on", periodFrom).lte("incurred_on", periodTo).eq("approval_status", "pending"),
  ]);
  if (itemError) throw new Error(itemError.message);
  if (movementError) throw new Error(movementError.message);
  if (paymentError) throw new Error(paymentError.message);
  if (unallocatedError) throw new Error(unallocatedError.message);
  if (pendingExpenseError) throw new Error(pendingExpenseError.message);

  // Actual cost is attributed back to the exact order line that consumed it.
  const actualByItem = new Map<string, number>();
  for (const m of (movements ?? []) as any[]) {
    if (!m.order_item_id) continue;
    actualByItem.set(
      m.order_item_id,
      (actualByItem.get(m.order_item_id) ?? 0) + Number(m.total_cost ?? 0),
    );
  }

  const itemRows = ((items ?? []) as any[]).filter((i) => i.status !== "voided");
  const orderById = new Map(orderRows.map((o) => [o.id, o]));
  const refundByOrder = new Map<string, number>();
  for (const payment of (payments ?? []) as any[]) {
    if (payment.refund_of && payment.state === "refunded") {
      refundByOrder.set(payment.order_id, (refundByOrder.get(payment.order_id) ?? 0) + Math.abs(Number(payment.amount ?? 0)));
    }
  }
  const lineRevenueByOrder = new Map<string, number>();
  for (const item of itemRows) {
    if (item.is_comp) continue;
    lineRevenueByOrder.set(item.order_id, (lineRevenueByOrder.get(item.order_id) ?? 0) + Math.max(0, Number(item.line_total ?? 0)));
  }
  const refundByLine = new Map<string, number>();
  for (const item of itemRows) {
    if (item.is_comp) continue;
    const orderRefund = refundByOrder.get(item.order_id) ?? 0;
    const orderRevenue = lineRevenueByOrder.get(item.order_id) ?? 0;
    if (orderRefund > 0 && orderRevenue > 0) {
      refundByLine.set(item.id, orderRefund * (Number(item.line_total ?? 0) / orderRevenue));
    }
  }
  const grossSales = itemRows.filter((i) => !i.is_comp).reduce((sum, i) => sum + Number(i.line_total ?? 0) + Number(i.discount ?? 0), 0);
  const discounts = itemRows.filter((i) => !i.is_comp).reduce((sum, i) => sum + Number(i.discount ?? 0), 0);
  const refunds = [...refundByOrder.values()].reduce((sum, amount) => sum + amount, 0);
  const grossTax = itemRows.filter((i) => !i.is_comp).reduce((sum, i) => sum + Number(i.tax_amount ?? 0), 0);
  const refundedTax = itemRows.filter((i) => !i.is_comp).reduce((sum, i) => {
    const lineTotal = Number(i.line_total ?? 0);
    return sum + (lineTotal > 0 ? Number(i.tax_amount ?? 0) * ((refundByLine.get(i.id) ?? 0) / lineTotal) : 0);
  }, 0);
  const taxCollected = Math.max(0, grossTax - refundedTax);
  const recipeCogs = itemRows.reduce((sum, i) => sum + (actualByItem.has(i.id) ? actualByItem.get(i.id)! : Number(i.line_cost ?? 0)), 0);
  const allLinesHaveActualMovements = itemRows.every((i) => actualByItem.has(i.id));
  const unallocatedRows = (unallocated ?? []) as any[];
  const pendingRows = (pendingExpenses ?? []) as any[];
  const unallocatedOperatingExpenses = unallocatedRows.reduce((sum, r) => sum + Number(r.source_amount ?? 0), 0);
  const pendingExpenseVerification = pendingRows.length > 0;
  const operational = calculateOperationalProfitability({
    currency,
    grossSales: Number(grossSales.toFixed(2)),
    discounts: Number(discounts.toFixed(2)),
    refunds: Number(refunds.toFixed(2)),
    salesAdjustments: 0,
    taxCollected: Number(taxCollected.toFixed(2)),
    recipeCogs: Number(recipeCogs.toFixed(2)),
    recipeCostBasis: allLinesHaveActualMovements ? "actual" : "standard",
    serviceConsumables: 0,
    consumablesCostBasis: "estimated",
    otherDirectVariableCosts: 0,
    allocatedOperatingExpenses,
    unallocatedOperatingExpenses: Number(unallocatedOperatingExpenses.toFixed(2)),
    pendingExpenseVerification,
    incompleteSourceData: true,
  });
  const dimensionMap = new Map<string, { dimension_type: "channel" | "outlet" | "property"; dimension_key: string; dimension_name: string; net_sales: number; direct_variable_costs: number; contribution: number; operating_profit: number }>();
  const addDimension = (type: "channel" | "outlet" | "property", key: string, name: string, net: number, cost: number) => {
    const id = `${type}:${key}`;
    const current = dimensionMap.get(id) ?? { dimension_type: type, dimension_key: key, dimension_name: name, net_sales: 0, direct_variable_costs: 0, contribution: 0, operating_profit: 0 };
    current.net_sales += net;
    current.direct_variable_costs += cost;
    current.contribution += net - cost;
    dimensionMap.set(id, current);
  };
  for (const item of itemRows) {
    const order = orderById.get(item.order_id);
    if (!order || item.is_comp) continue;
    const lineGross = Number(item.line_total ?? 0) + Number(item.discount ?? 0);
    const refundGross = refundByLine.get(item.id) ?? 0;
    const refundedTaxForLine = Number(item.line_total ?? 0) > 0
      ? Number(item.tax_amount ?? 0) * (refundGross / Number(item.line_total))
      : 0;
    const lineNet = lineGross - Number(item.discount ?? 0) - Number(item.tax_amount ?? 0) - refundGross + refundedTaxForLine;
    const lineCost = actualByItem.has(item.id) ? actualByItem.get(item.id)! : Number(item.line_cost ?? 0);
    addDimension("channel", String(item.channel ?? order.source ?? "unknown"), String(item.channel ?? order.source ?? "Unknown channel"), lineNet, lineCost);
    if (order.location_id) addDimension("outlet", order.location_id, order.location_id, lineNet, lineCost);
    if (order.property_id) addDimension("property", order.property_id, order.property_id, lineNet, lineCost);
  }
  const dimensions = [...dimensionMap.values()].map((d) => {
    const matchingOpex = allocationRows.filter((a) =>
      d.dimension_type === "outlet" ? a.location_id === d.dimension_key :
      d.dimension_type === "property" ? a.property_id === d.dimension_key : false
    ).reduce((sum, a) => sum + Number(a.amount ?? 0), 0);
    const allocated = d.dimension_type === "channel"
      ? allocatedOperatingExpenses * (d.net_sales / Math.max(operational.netSales, 0.01))
      : matchingOpex;
    return { ...d, net_sales: Number(d.net_sales.toFixed(2)), direct_variable_costs: Number(d.direct_variable_costs.toFixed(2)), contribution: Number(d.contribution.toFixed(2)), operating_profit: Number((d.contribution - allocated).toFixed(2)) };
  });
  const operationalTotals = {
    gross_sales: operational.grossSales, discounts: operational.discounts, refunds: operational.refunds,
    tax_collected: operational.taxCollected, net_sales: operational.netSales,
    service_consumables: operational.serviceConsumables, other_direct_variable_costs: operational.otherDirectVariableCosts,
    direct_variable_costs: operational.directVariableCosts, unallocated_operating_expenses: operational.unallocatedOperatingExpenses,
    confidence_state: operational.reconciliationState,
  };
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

  const allRows = [...agg.values()]
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
    .sort((a, b) => b.gross_profit - a.gross_profit);
  const rows = allRows.slice(0, input.limit);

  const revenue = Number(allRows.reduce((s, r) => s + r.revenue, 0).toFixed(2));
  const actual = Number(allRows.reduce((s, r) => s + r.actual_cost, 0).toFixed(4));
  const theoretical = Number(allRows.reduce((s, r) => s + r.theoretical_cost, 0).toFixed(4));
  const totals = {
    quantity_sold: Number(allRows.reduce((s, r) => s + r.quantity_sold, 0).toFixed(3)),
    revenue,
    theoretical_cost: theoretical,
    actual_cost: actual,
    variance: Number((actual - theoretical).toFixed(4)),
    gross_profit: Number((revenue - actual).toFixed(4)),
    margin_percent: revenue > 0 ? Number((((revenue - actual) / revenue) * 100).toFixed(2)) : null,
    food_cost_percent: revenue > 0 ? Number(((actual / revenue) * 100).toFixed(2)) : null,
    allocated_operating_expenses: allocatedOperatingExpenses,
    // Contribution is net menu revenue less direct recipe cost. Allocated
    // operating expenses are deducted only after contribution is calculated.
    contribution_profit: Number((revenue - actual).toFixed(2)),
    contribution_margin_percent: revenue > 0
      ? Number((((revenue - actual) / revenue) * 100).toFixed(2))
      : null,
    operating_profit: operational.operatingProfit,
    operating_margin_percent: operational.operatingMarginPercent,
    currency,
    ...operationalTotals,
  };

  if (input.persist && allRows.length > 0) {
    const { error } = await sb.from("restaurant_profitability_snapshots").insert(
      allRows.map((r) => ({
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
  const scope = await getTenantScope(sb, userId, input.tenantId);
  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  let q = sb
    .from("restaurant_profitability_snapshots")
    .select(
      "id, menu_item_id, menu_item_name, period_start, period_end, quantity_sold, revenue, theoretical_cost, actual_cost, variance, gross_profit, margin_percent, food_cost_percent, currency, computed_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("computed_at", { ascending: false })
    .limit(input.limit);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  if (!input.locationId && !input.propertyId) {
    const ids = await accessibleLocationIds(sb, scope);
    if (ids !== null) q = q.in("location_id", ids.length ? ids : [NO_MATCH_ID]);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}
