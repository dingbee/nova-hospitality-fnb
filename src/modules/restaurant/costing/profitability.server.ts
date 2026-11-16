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
    .select("amount, currency, property_id, location_id, source_id")
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
  let unallocatedQuery = sb.from("restaurant_cost_allocation_exceptions")
    .select("id, source_id, source_amount, currency, source_type")
    .eq("tenant_id", input.tenantId).eq("source_type", "operational_expense")
    .gte("period_start", periodFrom).lte("period_start", periodTo);
  let pendingExpenseQuery = sb.from("restaurant_operational_expenses")
    .select("id, amount, currency, approval_status, property_id, location_id")
    .eq("tenant_id", input.tenantId).gte("incurred_on", periodFrom).lte("incurred_on", periodTo).eq("approval_status", "pending");
  let consumptionProfileQuery = sb.from("restaurant_consumption_profiles")
    .select("id, cost_class, property_id, location_id")
    .eq("tenant_id", input.tenantId).eq("active", true);
  if (input.propertyId) {
    pendingExpenseQuery = pendingExpenseQuery.eq("property_id", input.propertyId);
    consumptionProfileQuery = consumptionProfileQuery.eq("property_id", input.propertyId);
  }
  if (input.locationId) {
    pendingExpenseQuery = pendingExpenseQuery.eq("location_id", input.locationId);
    consumptionProfileQuery = consumptionProfileQuery.eq("location_id", input.locationId);
  }
  const [{ data: items, error: itemError }, { data: movements, error: movementError }, { data: payments, error: paymentError }, { data: unallocated, error: unallocatedError }, { data: pendingExpenses, error: pendingExpenseError }, { data: consumptionEvents, error: consumptionError }, { data: consumptionProfiles, error: consumptionProfileError }] = await Promise.all([
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
    unallocatedQuery,
    pendingExpenseQuery,
    sb.from("restaurant_consumption_events")
      .select("id, stock_movement_id, order_id, order_item_id, cost_class, total_cost, currency")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    consumptionProfileQuery,
  ]);
  if (itemError) throw new Error(itemError.message);
  if (movementError) throw new Error(movementError.message);
  if (paymentError) throw new Error(paymentError.message);
  if (unallocatedError) throw new Error(unallocatedError.message);
  if (pendingExpenseError) throw new Error(pendingExpenseError.message);
  if (consumptionError) throw new Error(consumptionError.message);
  if (consumptionProfileError) throw new Error(consumptionProfileError.message);

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
  let unallocatedRows = (unallocated ?? []) as any[];
  if ((input.propertyId || input.locationId) && unallocatedRows.length > 0) {
    const sourceIds = [...new Set(unallocatedRows.map((r) => r.source_id).filter(Boolean))];
    const { data: scopedExpenseSources, error: scopedExpenseError } = await sb
      .from("restaurant_operational_expenses")
      .select("id, property_id, location_id")
      .eq("tenant_id", input.tenantId)
      .in("id", sourceIds);
    if (scopedExpenseError) throw new Error(scopedExpenseError.message);
    const allowedSourceIds = new Set(((scopedExpenseSources ?? []) as any[])
      .filter((e) => (!input.propertyId || e.property_id === input.propertyId) && (!input.locationId || e.location_id === input.locationId))
      .map((e) => e.id));
    unallocatedRows = unallocatedRows.filter((r) => allowedSourceIds.has(r.source_id));
  }
  const pendingRows = (pendingExpenses ?? []) as any[];
  const unallocatedOperatingExpenses = unallocatedRows.reduce((sum, r) => sum + Number(r.source_amount ?? 0), 0);
  const pendingExpenseVerification = pendingRows.length > 0;
  const consumptionEventRows = (consumptionEvents ?? []) as any[];
  const serviceConsumables = consumptionEventRows.filter((e) => e.cost_class === "service_consumable").reduce((sum, e) => sum + Number(e.total_cost ?? 0), 0);
  const otherDirectVariableCosts = consumptionEventRows.filter((e) => e.cost_class === "other_direct_variable").reduce((sum, e) => sum + Number(e.total_cost ?? 0), 0);
  const hasConsumptionProfiles = ((consumptionProfiles ?? []) as any[]).length > 0;
  const movementRows = (movements ?? []) as any[];
  const paymentRows = (payments ?? []) as any[];
  const currencyRows = [
    ...movementRows.map((r) => r.currency),
    ...paymentRows.map((r) => r.currency),
    ...consumptionEventRows.map((r) => r.currency),
    ...pendingRows.map((r) => r.currency),
    ...unallocatedRows.map((r) => r.currency),
  ];
  if (currencyRows.some((v) => !/^[A-Z]{3}$/.test(String(v ?? ""))) ||
      currencyRows.some((v) => v !== currency)) {
    throw new Error("Profitability source records contain missing or mismatched currency.");
  }
  const consumableCostByOrderItem = new Map<string, number>();
  for (const event of consumptionEventRows) {
    if (event.order_item_id) consumableCostByOrderItem.set(
      event.order_item_id,
      (consumableCostByOrderItem.get(event.order_item_id) ?? 0) + Number(event.total_cost ?? 0),
    );
  }
  const operational = calculateOperationalProfitability({
    currency,
    grossSales: Number(grossSales.toFixed(2)),
    discounts: Number(discounts.toFixed(2)),
    refunds: Number(refunds.toFixed(2)),
    salesAdjustments: 0,
    taxCollected: Number(taxCollected.toFixed(2)),
    recipeCogs: Number(recipeCogs.toFixed(2)),
    recipeCostBasis: allLinesHaveActualMovements ? "actual" : "standard",
    serviceConsumables: Number(serviceConsumables.toFixed(2)),
    consumablesCostBasis: hasConsumptionProfiles ? "actual" : "estimated",
    otherDirectVariableCosts: Number(otherDirectVariableCosts.toFixed(2)),
    allocatedOperatingExpenses,
    unallocatedOperatingExpenses: Number(unallocatedOperatingExpenses.toFixed(2)),
    pendingExpenseVerification,
    incompleteSourceData: !hasConsumptionProfiles,
  });
  const netSalesByLine = new Map<string, number>();
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
    const lineCost = (actualByItem.has(item.id) ? actualByItem.get(item.id)! : Number(item.line_cost ?? 0)) + (consumableCostByOrderItem.get(item.id) ?? 0);
    netSalesByLine.set(item.id, lineNet);
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
    row.revenue += item.is_comp ? 0 : (netSalesByLine.get(item.id) ?? Number(item.line_total ?? 0));
    row.theoretical_cost += Number(item.line_cost ?? 0);
    row.actual_cost += (actualByItem.get(item.id) ?? Number(item.line_cost ?? 0)) + (consumableCostByOrderItem.get(item.id) ?? 0);
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
    contribution_profit: operational.contribution,
    contribution_margin_percent: operational.contributionMarginPercent,
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

  if (input.persist) {
    const { data: snapshot, error: snapshotError } = await sb
      .from("restaurant_operational_profitability_snapshots")
      .insert({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        location_id: input.locationId ?? null,
        period_start: periodFrom,
        period_end: periodTo,
        currency,
        gross_sales: operational.grossSales,
        discounts: operational.discounts,
        refunds: operational.refunds,
        sales_adjustments: operational.salesAdjustments,
        tax_collected: operational.taxCollected,
        net_sales: operational.netSales,
        recipe_cogs: operational.recipeCogs,
        service_consumables: operational.serviceConsumables,
        other_direct_variable_costs: operational.otherDirectVariableCosts,
        direct_variable_costs: operational.directVariableCosts,
        contribution: operational.contribution,
        allocated_operating_expenses: operational.allocatedOperatingExpenses,
        unallocated_operating_expenses: operational.unallocatedOperatingExpenses,
        operating_profit: operational.operatingProfit,
        confidence_state: operational.reconciliationState,
        source_counts: {
          orders: orderRows.length, order_items: itemRows.length,
          stock_movements: ((movements ?? []) as any[]).length,
          refunds: (payments ?? []).filter((p: any) => p.refund_of && p.state === "refunded").length,
          consumable_events: consumptionEventRows.length,
          expense_allocations: allocationRows.length,
          unallocated_costs: unallocatedRows.length,
          pending_expenses: pendingRows.length,
        },
        source_references: {
          order_ids: orderIds,
          stock_movement_ids: ((movements ?? []) as any[]).map((m) => m.id),
          payment_ids: ((payments ?? []) as any[]).map((p: any) => p.id),
          consumable_event_ids: consumptionEventRows.map((e) => e.id),
          allocation_source_ids: allocationRows.map((a) => a.source_id).filter(Boolean),
          unallocated_source_ids: unallocatedRows.map((a) => a.source_id).filter(Boolean),
          pending_expense_ids: pendingRows.map((e) => e.id),
        },
        calculation_version: "phase5-v1",
        computed_by: userId,
      })
      .select("id")
      .single();
    if (snapshotError || !snapshot?.id) throw new Error(snapshotError?.message ?? "Profitability snapshot could not be persisted.");
    if (dimensions.length > 0) {
      const dimensionRows = dimensions.map((d) => ({
        tenant_id: input.tenantId,
        snapshot_id: snapshot.id,
        property_id: d.dimension_type === "property" ? d.dimension_key : input.propertyId ?? null,
        location_id: d.dimension_type === "outlet" ? d.dimension_key : input.locationId ?? null,
        dimension_type: d.dimension_type,
        dimension_key: d.dimension_key,
        dimension_name: d.dimension_name,
        currency,
        net_sales: d.net_sales,
        direct_variable_costs: d.direct_variable_costs,
        contribution: d.contribution,
        allocated_operating_expenses: Math.max(0, d.contribution - d.operating_profit),
        operating_profit: d.operating_profit,
        source_references: orderIds,
      }));
      const { error: dimensionError } = await sb
        .from("restaurant_operational_profitability_dimensions")
        .insert(dimensionRows);
      if (dimensionError) {
        await sb.from("restaurant_operational_profitability_snapshots").delete().eq("tenant_id", input.tenantId).eq("id", snapshot.id);
        throw new Error(dimensionError.message);
      }
    }
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

  return { periodStart: input.from, periodEnd: input.to, rows, totals, operational, dimensions };
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
