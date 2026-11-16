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
  recipe_actual_cost: number;
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
  sales_adjustments: number;
  net_sales: number;
  service_consumables: number;
  other_direct_variable_costs: number;
  direct_variable_costs: number;
  unallocated_operating_expenses: number;
  pending_expense_amount: number;
  confidence_state: string;
}

export async function computeProfitability(
  sb: Sb,
  userId: string,
  input: ProfitabilityInput,
): Promise<{
  periodStart: string;
  periodEnd: string;
  scope: { propertyId: string | null; locationId: string | null };
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
    allocated_operating_expenses: number;
    operating_profit: number;
    property_id: string | null;
    location_id: string | null;
    allocation_method: string;
    confidence_state: string;
    source_references: string[];
  }>;
}> {
  await assertCapability(sb, userId, input.tenantId, "profitability.manage", {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });

  let orderQuery = sb
    .from("restaurant_orders")
    .select("id, currency, property_id, location_id, source, subtotal, discount_total, tax_total, service_charge, total")
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
  const allocationPeriodFrom = `${periodFrom.slice(0, 7)}-01`;
  let reportingPropertyId = input.propertyId ?? null;
  if (input.locationId) {
    const { data: location, error: locationError } = await sb
      .from("restaurant_locations")
      .select("property_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.locationId)
      .single();
    if (locationError || !location?.property_id) throw new Error("A valid property reporting currency is required.");
    if (reportingPropertyId && reportingPropertyId !== location.property_id) {
      throw new Error("The selected outlet does not belong to the selected property.");
    }
    reportingPropertyId = location.property_id;
  }
  const prorateMonthlyAmount = (amount: number, monthStart: string) => {
    const [year, month] = monthStart.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
    const overlapStart = periodFrom > monthStart ? periodFrom : monthStart;
    const overlapEnd = periodTo < monthEnd ? periodTo : monthEnd;
    if (overlapEnd < overlapStart) return 0;
    const overlapDays = Math.floor((Date.parse(`${overlapEnd}T00:00:00Z`) - Date.parse(`${overlapStart}T00:00:00Z`)) / 86_400_000) + 1;
    return amount * overlapDays / daysInMonth;
  };
  let expenseAllocationQuery = sb
    .from("restaurant_cost_allocations")
    .select("amount, currency, property_id, location_id, source_id, allocation_method, period_start")
    .eq("tenant_id", input.tenantId)
    .eq("source_type", "operational_expense")
    .gte("period_start", allocationPeriodFrom)
    .lte("period_start", periodTo);
  if (reportingPropertyId) expenseAllocationQuery = expenseAllocationQuery.eq("property_id", reportingPropertyId);
  const { data: expenseAllocations, error: expenseAllocationError } = await expenseAllocationQuery;
  if (expenseAllocationError) throw new Error(expenseAllocationError.message);
  let allocationRows = (expenseAllocations ?? []) as any[];
  if (input.locationId) allocationRows = allocationRows.filter((row) => row.location_id === null || row.location_id === input.locationId);
  if (allocationRows.some((r) => !/^[A-Z]{3}$/.test(String(r.currency ?? "")))) {
    throw new Error("Allocated operating cost currency is missing or invalid.");
  }
  const currencies = new Set(allocationRows.map((r) => r.currency));
  const currencySet = new Set([...orderCurrencies, ...currencies]);
  if (currencySet.size > 1) throw new Error("Profitability cannot combine sales and operating costs across currencies.");
  let propertyQuery = sb.from("restaurant_properties").select("id,currency").eq("tenant_id", input.tenantId);
  if (reportingPropertyId) propertyQuery = propertyQuery.eq("id", reportingPropertyId);
  const { data: reportingProperties, error: reportingPropertyError } = await propertyQuery;
  if (reportingPropertyError) throw new Error(reportingPropertyError.message);
  const propertyCurrencySet = new Set(((reportingProperties ?? []) as any[]).map((p) => p.currency));
  if (propertyCurrencySet.size !== 1 || [...propertyCurrencySet].some((v) => !/^[A-Z]{3}$/.test(String(v ?? "")))) {
    throw new Error("A single valid property reporting currency is required for this profitability report.");
  }
  const currency = [...propertyCurrencySet][0] as string;
  if (currencySet.size > 0 && [...currencySet].some((sourceCurrency) => sourceCurrency !== currency)) {
    throw new Error("Profitability source currency does not match the reporting property's currency.");
  }
  const allocatedOperatingExpenses = Number(
    allocationRows.reduce((sum, row) => sum + prorateMonthlyAmount(Number(row.amount ?? 0), row.period_start), 0).toFixed(2),
  );
  let unallocatedQuery = sb.from("restaurant_cost_allocation_exceptions")
    .select("id, source_id, source_amount, currency, source_type, period_start")
    .eq("tenant_id", input.tenantId).eq("source_type", "operational_expense")
    .gte("period_start", allocationPeriodFrom).lte("period_start", periodTo);
  let pendingExpenseQuery = sb.from("restaurant_operational_expenses")
    .select("id, amount, currency, approval_status, property_id, location_id")
    .eq("tenant_id", input.tenantId).gte("incurred_on", periodFrom).lte("incurred_on", periodTo).eq("approval_status", "pending");
  let consumptionProfileQuery = sb.from("restaurant_consumption_profiles")
    .select("id, cost_class, property_id, location_id, effective_from, effective_to")
    .eq("tenant_id", input.tenantId).eq("active", true);
  if (reportingPropertyId) pendingExpenseQuery = pendingExpenseQuery.eq("property_id", reportingPropertyId);
  const [{ data: items, error: itemError }, { data: movements, error: movementError }, { data: payments, error: paymentError }, { data: unallocated, error: unallocatedError }, { data: pendingExpenses, error: pendingExpenseError }, { data: consumptionEvents, error: consumptionError }, { data: consumptionProfiles, error: consumptionProfileError }, { data: consumptionRules, error: consumptionRuleError }] = await Promise.all([
    sb.from("restaurant_order_items")
      .select("id, order_id, menu_item_id, description, quantity, line_total, line_cost, discount, tax_amount, service_charge_amount, status, is_comp, channel")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    sb.from("restaurant_stock_movements")
      .select("id, order_item_id, inventory_item_id, property_id, location_id, total_cost, currency, reference_type, reference_id, reason")
      .eq("tenant_id", input.tenantId).eq("movement_type", "consumption")
      .eq("reference_type", "restaurant_order").in("reference_id", orderIds),
    sb.from("restaurant_payments")
      .select("id, order_id, amount, state, refund_of, currency")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    unallocatedQuery,
    pendingExpenseQuery,
    sb.from("restaurant_consumption_events")
      .select("id, stock_movement_id, order_id, order_item_id, cost_class, total_cost, currency")
      .eq("tenant_id", input.tenantId).in("order_id", orderIds),
    consumptionProfileQuery,
    sb.from("restaurant_consumption_rules")
      .select("id, profile_id, inventory_item_id, quantity_per_cover, active, effective_from, effective_to")
      .eq("tenant_id", input.tenantId).eq("active", true),
  ]);
  if (itemError) throw new Error(itemError.message);
  if (movementError) throw new Error(movementError.message);
  if (paymentError) throw new Error(paymentError.message);
  if (unallocatedError) throw new Error(unallocatedError.message);
  if (pendingExpenseError) throw new Error(pendingExpenseError.message);
  if (consumptionError) throw new Error(consumptionError.message);
  if (consumptionProfileError) throw new Error(consumptionProfileError.message);
  if (consumptionRuleError) throw new Error(consumptionRuleError.message);

  const itemRows = ((items ?? []) as any[]).filter((i) => i.status !== "voided");
  const reportPropertyIds = ((reportingProperties ?? []) as any[]).map((property) => property.id);
  const profileRows = ((consumptionProfiles ?? []) as any[]).filter((p) =>
    p.active !== false && p.effective_from <= periodTo && (!p.effective_to || p.effective_to >= periodFrom) &&
    reportPropertyIds.some((propertyId) => p.property_id === null || p.property_id === propertyId) &&
    (!input.locationId || p.location_id === null || p.location_id === input.locationId)
  ).sort((a, b) =>
    Number(b.location_id === input.locationId) - Number(a.location_id === input.locationId) ||
    Number(b.property_id === input.propertyId) - Number(a.property_id === input.propertyId)
  );
  const profileById = new Map(profileRows.map((p) => [p.id, p]));
  const ruleRows = ((consumptionRules ?? []) as any[]).filter((r) =>
    r.active !== false && r.effective_from <= periodTo && (!r.effective_to || r.effective_to >= periodFrom) &&
    profileById.has(r.profile_id)
  );
  const rulesByInventoryItem = new Map<string, Array<{ rule: any; profile: any }>>();
  for (const rule of ruleRows) {
    const profile = profileById.get(rule.profile_id);
    if (!profile) continue;
    const matches = rulesByInventoryItem.get(rule.inventory_item_id) ?? [];
    matches.push({ rule, profile });
    rulesByInventoryItem.set(rule.inventory_item_id, matches);
  }
  const classifyConsumableMovement = (movement: any): "service_consumable" | "other_direct_variable" | null => {
    if (String(movement.reason ?? "").startsWith("Operational service consumable")) return "service_consumable";
    if (String(movement.reason ?? "").startsWith("Operational other direct variable")) return "other_direct_variable";
    const matches = (rulesByInventoryItem.get(movement.inventory_item_id) ?? [])
      .filter(({ profile }) =>
        (profile.property_id === null || profile.property_id === movement.property_id) &&
        (profile.location_id === null || profile.location_id === movement.location_id)
      )
      .sort((a, b) =>
        Number(b.profile.location_id !== null) - Number(a.profile.location_id !== null) ||
        Number(b.profile.property_id !== null) - Number(a.profile.property_id !== null)
      );
    return matches[0]?.profile.cost_class ?? null;
  };
  const movementRows = (movements ?? []) as any[];
  const consumptionEventRows = (consumptionEvents ?? []) as any[];
  const capturedConsumableMovementIds = new Set(consumptionEventRows.map((e) => e.stock_movement_id));
  const missingConsumableMovements = movementRows.filter((m) =>
    classifyConsumableMovement(m) !== null && !capturedConsumableMovementIds.has(m.id)
  );
  const missingServiceConsumables = missingConsumableMovements
    .filter((m) => classifyConsumableMovement(m) === "service_consumable")
    .reduce((sum, m) => sum + Number(m.total_cost ?? 0), 0);
  const missingOtherDirectCosts = missingConsumableMovements
    .filter((m) => classifyConsumableMovement(m) === "other_direct_variable")
    .reduce((sum, m) => sum + Number(m.total_cost ?? 0), 0);
  const hasRule = (profileId: string) => ruleRows.some((rule) => rule.profile_id === profileId);
  const hasConsumptionProfiles = reportPropertyIds.length > 0 && reportPropertyIds.every((propertyId) => {
    const applicable = profileRows.filter((profile) => profile.property_id === null || profile.property_id === propertyId);
    if (applicable.some((profile) => profile.location_id === null && hasRule(profile.id))) return true;
    const locations = input.locationId
      ? [input.locationId]
      : [...new Set(orderRows.filter((order) => order.property_id === propertyId).map((order) => order.location_id).filter(Boolean))];
    return locations.length > 0 && locations.every((locationId) =>
      applicable.some((profile) => profile.location_id === locationId && hasRule(profile.id))
    );
  });
  const expectedConsumableCaptureMissing = orderRows.some((order) => {
    const expectedInventoryIds = new Set(ruleRows.filter((rule) => {
      const profile = profileById.get(rule.profile_id);
      return Number(rule.quantity_per_cover ?? 0) > 0 && profile &&
        (profile.property_id === null || profile.property_id === order.property_id) &&
        (profile.location_id === null || profile.location_id === order.location_id);
    }).map((rule) => rule.inventory_item_id));
    return [...expectedInventoryIds].some((inventoryItemId) =>
      !movementRows.some((movement) =>
        movement.reference_id === order.id && movement.inventory_item_id === inventoryItemId
      )
    );
  });
  const invalidConsumableRule = ruleRows.some((rule) => Number(rule.quantity_per_cover ?? 0) <= 0);
  const consumableCoverageIncomplete = !hasConsumptionProfiles || missingConsumableMovements.length > 0 ||
    expectedConsumableCaptureMissing || invalidConsumableRule;
  // Service consumable movements are projected separately by Phase 1;
  // exclude them from recipe COGS so direct costs are never double-counted.
  const actualByItem = new Map<string, number>();
  for (const m of movementRows) {
    if (!m.order_item_id || classifyConsumableMovement(m) !== null) continue;
    actualByItem.set(
      m.order_item_id,
      (actualByItem.get(m.order_item_id) ?? 0) + Number(m.total_cost ?? 0),
    );
  }

  const orderById = new Map(orderRows.map((o) => [o.id, o]));
  // Discounts and refunds are the complete adjustment scope for this release.
  // Discounts are sourced from persisted order-item discount amounts. Refunds
  // are sourced from the payment ledger: child refund rows are summed against
  // their original payment; a fully-refunded original payment (used by some
  // payment-provider callbacks) is recognised at its original amount. When
  // both representations exist, use the greater committed amount, never add
  // the same refund twice.
  const refundByPayment = new Map<string, {
    orderId: string;
    originalAmount: number;
    originalRefunded: boolean;
    childRefundAmount: number;
  }>();
  for (const payment of (payments ?? []) as any[]) {
    if (payment.refund_of) {
      const originalId = String(payment.refund_of);
      const entry = refundByPayment.get(originalId) ?? {
        orderId: payment.order_id,
        originalAmount: 0,
        originalRefunded: false,
        childRefundAmount: 0,
      };
      if (payment.state === "refunded") {
        entry.childRefundAmount += Math.abs(Number(payment.amount ?? 0));
      }
      refundByPayment.set(originalId, entry);
      continue;
    }
    const entry = refundByPayment.get(String(payment.id)) ?? {
      orderId: payment.order_id,
      originalAmount: 0,
      originalRefunded: false,
      childRefundAmount: 0,
    };
    entry.orderId = payment.order_id;
    entry.originalAmount = Math.abs(Number(payment.amount ?? 0));
    entry.originalRefunded = payment.state === "refunded";
    refundByPayment.set(String(payment.id), entry);
  }
  const refundByOrder = new Map<string, number>();
  for (const refund of refundByPayment.values()) {
    const recognisedRefund = Math.max(
      refund.childRefundAmount,
      refund.originalRefunded ? refund.originalAmount : 0,
    );
    if (recognisedRefund > 0) {
      refundByOrder.set(
        refund.orderId,
        (refundByOrder.get(refund.orderId) ?? 0) + recognisedRefund,
      );
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
  const orderLineTotals = new Map<string, { total: number; discount: number; tax: number; serviceCharge: number }>();
  for (const item of itemRows) {
    if (item.is_comp) continue;
    const row = orderLineTotals.get(item.order_id) ?? { total: 0, discount: 0, tax: 0, serviceCharge: 0 };
    row.total += Number(item.line_total ?? 0);
    row.discount += Number(item.discount ?? 0);
    row.tax += Number(item.tax_amount ?? 0);
    row.serviceCharge += Number(item.service_charge_amount ?? 0);
    orderLineTotals.set(item.order_id, row);
  }
  const orderSourceMismatchIds = orderRows.filter((order) => {
    const totals = orderLineTotals.get(order.id) ?? { total: 0, discount: 0, tax: 0, serviceCharge: 0 };
    return Math.abs(totals.total - Number(order.total ?? 0)) > 0.01 ||
      Math.abs(totals.discount - Number(order.discount_total ?? 0)) > 0.01 ||
      Math.abs(totals.tax - Number(order.tax_total ?? 0)) > 0.01 ||
      Math.abs(totals.serviceCharge - Number(order.service_charge ?? 0)) > 0.01;
  }).map((order) => order.id);
  const salesSourceMismatch = orderSourceMismatchIds.length > 0;
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
      .filter((e) => (!reportingPropertyId || e.property_id === reportingPropertyId) && (!input.locationId || e.location_id === null || e.location_id === input.locationId))
      .map((e) => e.id));
    unallocatedRows = unallocatedRows.filter((r) => allowedSourceIds.has(r.source_id));
  }
  const pendingRows = ((pendingExpenses ?? []) as any[]).filter((expense) =>
    !input.locationId || expense.location_id === null || expense.location_id === input.locationId
  );
  const unallocatedOperatingExpenses = unallocatedRows.reduce((sum, r) => sum + prorateMonthlyAmount(Number(r.source_amount ?? 0), r.period_start), 0);
  const pendingExpenseVerification = pendingRows.length > 0;
  const pendingExpenseAmount = pendingRows.reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);
  const serviceConsumables = consumptionEventRows.filter((e) => e.cost_class === "service_consumable").reduce((sum, e) => sum + Number(e.total_cost ?? 0), 0) + missingServiceConsumables;
  const otherDirectVariableCosts = consumptionEventRows.filter((e) => e.cost_class === "other_direct_variable").reduce((sum, e) => sum + Number(e.total_cost ?? 0), 0) + missingOtherDirectCosts;
  const { data: reconciliationRuns, error: reconciliationError } = reportPropertyIds.length > 0
    ? await sb.from("restaurant_cost_reconciliation_runs")
        .select("id, property_id, status, source_counts, created_at")
        .eq("tenant_id", input.tenantId)
        .in("property_id", reportPropertyIds)
        .eq("period_start", periodFrom)
        .eq("period_end", periodTo)
        .eq("currency", currency)
        .eq("status", "completed")
    : { data: [], error: null };
  if (reconciliationError) throw new Error(reconciliationError.message);
  const completedPropertyIds = new Set(((reconciliationRuns ?? []) as any[]).map((r) => r.property_id));
  const partiallyReconciled = reportPropertyIds.some((propertyId) => !completedPropertyIds.has(propertyId));
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
  const addConsumableCost = (orderItemId: string | null, orderId: string | null, amount: number) => {
    if (orderItemId) {
      consumableCostByOrderItem.set(orderItemId, (consumableCostByOrderItem.get(orderItemId) ?? 0) + amount);
    } else if (orderId) {
      const orderLines = itemRows.filter((item) => item.order_id === orderId && !item.is_comp);
      const orderLineValue = orderLines.reduce((sum, item) => sum + Math.max(0, Number(item.line_total ?? 0)), 0);
      for (const item of orderLines) {
        const share = orderLineValue > 0 ? Math.max(0, Number(item.line_total ?? 0)) / orderLineValue : 1 / Math.max(orderLines.length, 1);
        consumableCostByOrderItem.set(item.id, (consumableCostByOrderItem.get(item.id) ?? 0) + amount * share);
      }
    }
  };
  for (const event of consumptionEventRows) {
    addConsumableCost(event.order_item_id ?? null, event.order_id ?? null, Number(event.total_cost ?? 0));
  }
  for (const movement of missingConsumableMovements) {
    addConsumableCost(
      movement.order_item_id ?? null,
      movement.reference_type === "restaurant_order" ? movement.reference_id : null,
      Number(movement.total_cost ?? 0),
    );
  }
  // No separate sales-adjustment ledger exists in the current POS contract.
  // Discounts and refunds above are the complete adjustment scope; keep the
  // explicit calculation input at zero rather than inventing an untraceable
  // adjustment amount.
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
    pendingExpenseAmount,
    partiallyReconciled,
    incompleteSourceData: consumableCoverageIncomplete || salesSourceMismatch,
  });
  const netSalesByLine = new Map<string, number>();
  const dimensionMap = new Map<string, { dimension_type: "channel" | "outlet" | "property"; dimension_key: string; dimension_name: string; property_id: string | null; location_id: string | null; net_sales: number; direct_variable_costs: number; contribution: number; allocated_operating_expenses: number; operating_profit: number; source_references: string[] }>();
  const propertyNetSalesById = new Map<string, number>();
  const locationNetSalesByKey = new Map<string, number>();
  const channelNetSalesByPropertyKey = new Map<string, number>();
  const channelNetSalesByLocationKey = new Map<string, number>();
  const addDimension = (
    type: "channel" | "outlet" | "property",
    key: string,
    name: string,
    net: number,
    cost: number,
    propertyId: string | null,
    locationId: string | null,
    sourceId: string,
  ) => {
    const id = `${type}:${propertyId ?? "tenant"}:${locationId ?? "all"}:${key}`;
    const current = dimensionMap.get(id) ?? {
      dimension_type: type,
      dimension_key: key,
      dimension_name: name,
      property_id: propertyId,
      location_id: locationId,
      net_sales: 0,
      direct_variable_costs: 0,
      contribution: 0,
      allocated_operating_expenses: 0,
      operating_profit: 0,
      source_references: [],
    };
    if (!current.source_references.includes(sourceId)) current.source_references.push(sourceId);
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
    const lineCost = (actualByItem.has(item.id) ? actualByItem.get(item.id)! : Number(item.line_cost ?? 0)) +
      (consumableCostByOrderItem.get(item.id) ?? 0);
    netSalesByLine.set(item.id, lineNet);
    const channel = String(item.channel ?? order.source ?? "unknown");
    const channelKey = `${order.property_id ?? "tenant"}:${channel}`;
    addDimension("channel", channelKey, channel, lineNet, lineCost, order.property_id ?? null, null, order.id);
    if (order.property_id) {
      propertyNetSalesById.set(order.property_id, (propertyNetSalesById.get(order.property_id) ?? 0) + lineNet);
      channelNetSalesByPropertyKey.set(channelKey, (channelNetSalesByPropertyKey.get(channelKey) ?? 0) + lineNet);
      if (order.location_id) {
        const locationKey = `${order.property_id}:${order.location_id}`;
        locationNetSalesByKey.set(locationKey, (locationNetSalesByKey.get(locationKey) ?? 0) + lineNet);
        const channelLocationKey = `${locationKey}:${channel}`;
        channelNetSalesByLocationKey.set(channelLocationKey, (channelNetSalesByLocationKey.get(channelLocationKey) ?? 0) + lineNet);
      }
      addDimension("property", order.property_id, order.property_id, lineNet, lineCost, order.property_id, null, order.id);
    }
    if (order.location_id) {
      addDimension("outlet", order.location_id, order.location_id, lineNet, lineCost, order.property_id ?? null, order.location_id, order.id);
    }
  }
  const sumAllocationRows = (rows: any[]) =>
    rows.reduce((sum, row) => sum + prorateMonthlyAmount(Number(row.amount ?? 0), row.period_start), 0);
  const allocationMethodFor = (rows: any[]) => {
    const methods = [...new Set(rows.map((row) => row.allocation_method).filter(Boolean))];
    return methods.length === 0 ? "none" : methods.length === 1 ? methods[0] : "mixed";
  };
  const dimensions = [...dimensionMap.values()].map((d) => {
    const propertyRows = allocationRows.filter((a) => a.property_id === d.property_id);
    const propertyLevelRows = propertyRows.filter((a) => a.location_id === null);
    const locationRows = propertyRows.filter((a) => a.location_id === d.location_id && a.location_id !== null);
    const propertyLevelOpex = sumAllocationRows(propertyLevelRows);
    const locationDirectOpex = sumAllocationRows(locationRows);
    const allPropertyOpex = sumAllocationRows(propertyRows);
    const propertyNetSales = d.property_id ? propertyNetSalesById.get(d.property_id) ?? 0 : 0;
    const locationKey = d.property_id && d.location_id ? `${d.property_id}:${d.location_id}` : "";
    const locationNetSales = locationKey ? locationNetSalesByKey.get(locationKey) ?? 0 : 0;
    let allocated = 0;
    let allocationMethod = "none";
    let dimensionConfidence = operational.reconciliationState;

    if (d.dimension_type === "property") {
      allocated = allPropertyOpex;
      allocationMethod = allocationMethodFor(propertyRows);
    } else if (d.dimension_type === "outlet") {
      allocated = locationDirectOpex + (propertyNetSales > 0 ? propertyLevelOpex * (locationNetSales / propertyNetSales) : 0);
      allocationMethod = propertyLevelOpex > 0
        ? (locationDirectOpex > 0 ? "mixed" : "sales_proportional")
        : allocationMethodFor(locationRows);
      if (propertyLevelOpex > 0 && dimensionConfidence === "fully_reconciled") dimensionConfidence = "estimated";
    } else if (d.dimension_type === "channel") {
      const channelKey = `${d.property_id ?? "tenant"}:${d.dimension_name}`;
      const channelNetSales = channelNetSalesByPropertyKey.get(channelKey) ?? 0;
      const propertyLevelShare = propertyNetSales > 0 ? propertyLevelOpex * (channelNetSales / propertyNetSales) : 0;
      const locationAllocationById = new Map<string, number>();
      for (const row of propertyRows.filter((a) => a.location_id !== null)) {
        locationAllocationById.set(row.location_id, (locationAllocationById.get(row.location_id) ?? 0) + prorateMonthlyAmount(Number(row.amount ?? 0), row.period_start));
      }
      let locationLevelShare = 0;
      for (const [locationId, locationOpex] of locationAllocationById) {
        const locationSales = locationNetSalesByKey.get(`${d.property_id}:${locationId}`) ?? 0;
        const channelLocationSales = channelNetSalesByLocationKey.get(`${d.property_id}:${locationId}:${d.dimension_name}`) ?? 0;
        if (locationSales > 0) locationLevelShare += locationOpex * (channelLocationSales / locationSales);
      }
      allocated = propertyLevelShare + locationLevelShare;
      allocationMethod = allPropertyOpex > 0 ? "sales_proportional" : "none";
      if (allPropertyOpex > 0 && dimensionConfidence === "fully_reconciled") dimensionConfidence = "estimated";
    }
    return {
      ...d,
      net_sales: Number(d.net_sales.toFixed(2)),
      direct_variable_costs: Number(d.direct_variable_costs.toFixed(2)),
      contribution: Number(d.contribution.toFixed(2)),
      allocated_operating_expenses: Number(allocated.toFixed(2)),
      operating_profit: Number((d.contribution - allocated).toFixed(2)),
      allocation_method: allocationMethod,
      confidence_state: dimensionConfidence,
    };
  });
  const operationalTotals = {
    gross_sales: operational.grossSales, discounts: operational.discounts, refunds: operational.refunds,
    sales_adjustments: operational.salesAdjustments, tax_collected: operational.taxCollected, net_sales: operational.netSales,
    service_consumables: operational.serviceConsumables, other_direct_variable_costs: operational.otherDirectVariableCosts,
    direct_variable_costs: operational.directVariableCosts, unallocated_operating_expenses: operational.unallocatedOperatingExpenses,
    pending_expense_amount: operational.pendingExpenseAmount,
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
        recipe_actual_cost: 0,
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
    const recipeActualCost = actualByItem.get(item.id) ?? Number(item.line_cost ?? 0);
    row.recipe_actual_cost += recipeActualCost;
    row.actual_cost += recipeActualCost + (consumableCostByOrderItem.get(item.id) ?? 0);
    agg.set(key, row);
  }

  const allRows = [...agg.values()]
    .map((r) => {
      const revenue = Number(r.revenue.toFixed(2));
      const actual = Number(r.actual_cost.toFixed(4));
      const recipeActual = Number(r.recipe_actual_cost.toFixed(4));
      const theoretical = Number(r.theoretical_cost.toFixed(4));
      const grossProfit = Number((revenue - actual).toFixed(4));
      return {
        ...r,
        revenue,
        actual_cost: actual,
        recipe_actual_cost: recipeActual,
        theoretical_cost: theoretical,
        variance: Number((recipeActual - theoretical).toFixed(4)),
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
  const recipeActual = Number(allRows.reduce((s, r) => s + r.recipe_actual_cost, 0).toFixed(4));
  const theoretical = Number(allRows.reduce((s, r) => s + r.theoretical_cost, 0).toFixed(4));
  const totals = {
    quantity_sold: Number(allRows.reduce((s, r) => s + r.quantity_sold, 0).toFixed(3)),
    revenue,
    theoretical_cost: theoretical,
    actual_cost: actual,
    recipe_actual_cost: recipeActual,
    variance: Number(allRows.reduce((sum, row) => sum + row.variance, 0).toFixed(4)),
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

  const canPersistScopedSnapshot = Boolean(input.propertyId || input.locationId);
  if (input.persist && canPersistScopedSnapshot && allRows.length > 0) {
    const { error } = await sb.from("restaurant_profitability_snapshots").insert(
      allRows.map((r) => ({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? reportingPropertyId,
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

  if (input.persist && canPersistScopedSnapshot) {
    const { data: snapshot, error: snapshotError } = await sb
      .from("restaurant_operational_profitability_snapshots")
      .insert({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? reportingPropertyId,
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
        pending_expense_amount: operational.pendingExpenseAmount,
        operating_profit: operational.operatingProfit,
        contribution_margin_percent: operational.contributionMarginPercent,
        operating_margin_percent: operational.operatingMarginPercent,
        confidence_state: operational.reconciliationState,
        calculation_inputs: {
          currency,
          period_start: periodFrom,
          period_end: periodTo,
          property_id: input.propertyId ?? reportingPropertyId,
          location_id: input.locationId ?? null,
          gross_sales: operational.grossSales,
          discounts: operational.discounts,
          refunds: operational.refunds,
          sales_adjustments: operational.salesAdjustments,
          tax_collected: operational.taxCollected,
          recipe_cogs: operational.recipeCogs,
          recipe_cost_basis: operational.recipeCostBasis,
          service_consumables: operational.serviceConsumables,
          consumables_cost_basis: operational.consumablesCostBasis,
          other_direct_variable_costs: operational.otherDirectVariableCosts,
          allocated_operating_expenses: operational.allocatedOperatingExpenses,
          unallocated_operating_expenses: operational.unallocatedOperatingExpenses,
          pending_expense_amount: operational.pendingExpenseAmount,
          pending_expense_verification: pendingExpenseVerification,
          partially_reconciled: partiallyReconciled,
          incomplete_source_data: consumableCoverageIncomplete || salesSourceMismatch,
          calculation_version: "phase5-v1",
        },
        source_counts: {
          orders: orderRows.length, order_items: itemRows.length,
          order_source_mismatches: orderSourceMismatchIds.length,
          pending_expenses: pendingRows.length,
          stock_movements: ((movements ?? []) as any[]).length,
          refunds: (payments ?? []).filter((p: any) => p.refund_of && p.state === "refunded").length,
          consumable_events: consumptionEventRows.length,
          expense_allocations: allocationRows.length,
          unallocated_costs: unallocatedRows.length,
        },
        source_references: {
          order_ids: orderIds,
          order_source_mismatch_ids: orderSourceMismatchIds,
          pending_expense_ids: pendingRows.map((expense) => expense.id),
          stock_movement_ids: ((movements ?? []) as any[]).map((m) => m.id),
          payment_ids: ((payments ?? []) as any[]).map((p: any) => p.id),
          consumable_event_ids: consumptionEventRows.map((e) => e.id),
          unclassified_consumable_movement_ids: missingConsumableMovements.map((m) => m.id),
          reconciliation_run_ids: ((reconciliationRuns ?? []) as any[]).map((r) => r.id),
          allocation_source_ids: allocationRows.map((a) => a.source_id).filter(Boolean),
          unallocated_source_ids: unallocatedRows.map((a) => a.source_id).filter(Boolean),
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
        property_id: d.property_id,
        location_id: d.location_id,
        dimension_type: d.dimension_type,
        dimension_key: d.dimension_key,
        dimension_name: d.dimension_name,
        currency,
        net_sales: d.net_sales,
        direct_variable_costs: d.direct_variable_costs,
        contribution: d.contribution,
        allocated_operating_expenses: Math.max(0, d.contribution - d.operating_profit),
        operating_profit: d.operating_profit,
        allocation_method: d.allocation_method,
        confidence_state: d.confidence_state,
        source_references: d.source_references,
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

  return {
    periodStart: input.from,
    periodEnd: input.to,
    scope: { propertyId: input.propertyId ?? reportingPropertyId, locationId: input.locationId ?? null },
    rows,
    totals,
    operational,
    dimensions,
  };
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
  const [{ data, error }, { data: operationalSnapshots, error: operationalSnapshotError }] = await Promise.all([
    q,
    (() => {
      let operationalQuery = sb
        .from("restaurant_operational_profitability_snapshots")
        .select("id, property_id, location_id, period_start, period_end, currency, net_sales, direct_variable_costs, contribution, operating_profit, operating_margin_percent, pending_expense_amount, confidence_state, source_counts, source_references, calculation_version, computed_at")
        .eq("tenant_id", input.tenantId)
        .order("computed_at", { ascending: false })
        .limit(input.limit);
      if (input.locationId) operationalQuery = operationalQuery.eq("location_id", input.locationId);
      if (input.propertyId) operationalQuery = operationalQuery.eq("property_id", input.propertyId);
      return operationalQuery;
    })(),
  ]);
  if (error) throw new Error(error.message);
  if (operationalSnapshotError) throw new Error(operationalSnapshotError.message);
  const operationalRows = ((operationalSnapshots ?? []) as any[]).map((s) => ({
    id: s.id,
    menu_item_id: null,
    menu_item_name: "Operational profitability",
    period_start: s.period_start,
    period_end: s.period_end,
    quantity_sold: 0,
    revenue: Number(s.net_sales ?? 0),
    theoretical_cost: 0,
    actual_cost: Number(s.direct_variable_costs ?? 0),
    variance: 0,
    gross_profit: Number(s.operating_profit ?? 0),
    margin_percent: s.operating_margin_percent,
    food_cost_percent: null,
    currency: s.currency,
    computed_at: s.computed_at,
    snapshot_type: "operational",
    contribution: Number(s.contribution ?? 0),
    confidence_state: s.confidence_state,
    pending_expense_amount: Number(s.pending_expense_amount ?? 0),
    source_counts: s.source_counts,
    source_references: s.source_references,
    calculation_version: s.calculation_version,
  }));
  return [...(data ?? []), ...operationalRows]
    .sort((a: any, b: any) => new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime())
    .slice(0, input.limit);
}
