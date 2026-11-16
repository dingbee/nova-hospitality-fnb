/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3.4 — Purchasing Intelligence.
 * Forecast-driven purchase quantities, supplier reliability ranking, and the
 * expected cost impact of next month's consumption.
 */
import { assertTenantRead } from "../core/access.server";
import { getStockPositionEvidenceForReplenishment } from "../inventory/positions.server";
import { calculateReplenishment, calculateStockPosition, comparableSupplierUnitCost, forecastDailyDemand, stockUnitsPerUnit } from "../inventory/stock-position.contract";
import { percentChange, reliabilityScore, round } from "./analysis";
import type {
  PurchaseSuggestion,
  PurchasingIntelligence,
  RestaurantInsight,
  SupplierReliability,
} from "./types";

type Sb = any;
const DAY = 864e5;
const COVER_DAYS = 7;

export async function getPurchasingIntelligence(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    windowDays: number;
    propertyId?: string | null;
    locationId?: string | null;
  },
): Promise<PurchasingIntelligence> {
  const { tenantId, windowDays } = input;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error("Purchasing intelligence requires a positive, finite analysis window.");
  }
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const monthStart = new Date(now - 30 * DAY).toISOString();
  const prevMonthStart = new Date(now - 60 * DAY).toISOString();

  let itemsQuery = sb
    .from("restaurant_inventory_items")
    .select(
      "id, name, property_id, location_id, current_quantity, average_cost, currency, unit_id, purchase_unit_id, pack_size, reorder_point, par_level, metadata, updated_at",
    )
    .eq("tenant_id", tenantId);
  if (input.propertyId) itemsQuery = itemsQuery.or("property_id.eq." + input.propertyId + ",property_id.is.null");

  let movesQuery = sb
    .from("restaurant_stock_movements")
    .select("inventory_item_id, movement_type, quantity, total_cost, occurred_at")
    .eq("tenant_id", tenantId)
    .gte("occurred_at", prevMonthStart);
  if (input.propertyId) movesQuery = movesQuery.eq("property_id", input.propertyId);
  if (input.locationId) movesQuery = movesQuery.eq("location_id", input.locationId);

  const [itemsRes, movesRes, productsRes, suppliersRes, poRes, unitsRes] = await Promise.all([
    itemsQuery,
    movesQuery,
    sb
      .from("restaurant_supplier_products")
      .select(
        "id, supplier_id, inventory_item_id, unit_id, pack_size, unit_price, currency, min_order_quantity, lead_time_days, last_price_at, active",
      )
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_suppliers")
      .select("id, name, lead_time_days, reliability_score, status")
      .eq("tenant_id", tenantId),
    (() => {
      let q = sb
        .from("restaurant_purchase_orders")
        .select(
          "id, supplier_id, status, order_date, expected_at, received_at, total, property_id, location_id",
        )
        .eq("tenant_id", tenantId);
      if (input.propertyId) q = q.eq("property_id", input.propertyId);
      if (input.locationId) q = q.eq("location_id", input.locationId);
      return q;
    })(),
    sb.from("restaurant_inventory_units").select("id, dimension, base_unit_id, factor").or("tenant_id.eq." + tenantId + ",tenant_id.is.null"),
  ]);

  for (const [label, result] of [
    ["inventory items", itemsRes],
    ["stock movements", movesRes],
    ["supplier products", productsRes],
    ["suppliers", suppliersRes],
    ["purchase orders", poRes],
    ["inventory units", unitsRes],
  ] as const) {
    if (result.error)
      throw new Error(
        "Unable to load " + label + " for purchasing intelligence: " + result.error.message,
      );
  }

  const items = (itemsRes.data ?? []) as any[];
  const moves = (movesRes.data ?? []) as any[];
  const orders = (poRes.data ?? []) as any[];
  const suppliers = ((suppliersRes.data ?? []) as any[]).filter((s) => s.status === "active");
  const products = ((productsRes.data ?? []) as any[]).filter((p) => p.active === true);
  const units = (unitsRes.data ?? []) as any[];
  const currency = (items[0]?.currency as string) ?? "TZS";
  const itemById = new Map(items.map((item) => [item.id, item]));
  const stockEvidence = await getStockPositionEvidenceForReplenishment(sb, userId, {
    tenantId,
    itemIds: items.map((item) => item.id),
    items,
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
    asOf: new Date(now).toISOString(),
  });

  const productIds = products.map((product) => product.id);
  const historyRes = productIds.length
    ? await sb.from("restaurant_supplier_price_history")
        .select("supplier_product_id, unit_id, price, currency, effective_date, price_type, created_at")
        .eq("tenant_id", tenantId)
        .in("supplier_product_id", productIds)
        .lte("effective_date", new Date(now).toISOString().slice(0, 10))
    : { data: [], error: null };
  if (historyRes.error) throw new Error("Unable to load effective supplier price history: " + historyRes.error.message);
  const historyRows = (historyRes.data ?? []) as any[];
  const latestPriceByProduct = new Map<string, any>();
  for (const row of historyRows) {
    const previous = latestPriceByProduct.get(row.supplier_product_id);
    if (!previous || String(row.effective_date) > String(previous.effective_date) || (String(row.effective_date) === String(previous.effective_date) && String(row.created_at) > String(previous.created_at))) {
      latestPriceByProduct.set(row.supplier_product_id, row);
    }
  }

  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const bestProduct = new Map<string, any>();
  for (const product of products) {
    const item = itemById.get(product.inventory_item_id);
    const supplier = supplierById.get(product.supplier_id);
    if (!item || !supplier || !item.unit_id || !product.unit_id) continue;
    const stockFactor = stockUnitsPerUnit(
      product.unit_id,
      item.unit_id,
      product.unit_id === item.purchase_unit_id ? product.unit_id : null,
      Number(product.pack_size),
      units,
    );
    if (stockFactor == null) continue;
    const history = latestPriceByProduct.get(product.id);
    const effectivePrice = history ?? product;
    if (history && (history.unit_id !== product.unit_id || history.currency !== product.currency)) continue;
    const price = Number(effectivePrice.price ?? effectivePrice.unit_price);
    const normalizedStockUnitPrice = comparableSupplierUnitCost(
      price,
      effectivePrice.currency,
      item.currency ?? currency,
      stockFactor,
    );
    if (normalizedStockUnitPrice == null) continue;
    const normalized = {
      ...product,
      effectiveUnitPrice: price,
      effectivePriceDate: history?.effective_date ?? product.last_price_at ?? null,
      stockUnitsPerPurchaseUnit: stockFactor,
      normalizedStockUnitPrice,
    };
    const previous = bestProduct.get(item.id);
    if (!previous || normalized.normalizedStockUnitPrice < previous.normalizedStockUnitPrice) {
      bestProduct.set(item.id, normalized);
    }
  }

  const dailyByItem = new Map<string, number[]>();
  const observedDaysByItem = new Map<string, Set<string>>();
  const observedStart = new Date(now - windowDays * DAY);
  for (const item of items) dailyByItem.set(item.id, Array.from({ length: Math.ceil(windowDays) }, () => 0));
  for (const movement of moves) {
    if (movement.movement_type !== "consumption") continue;
    const occurred = Date.parse(movement.occurred_at);
    if (!Number.isFinite(occurred) || occurred < observedStart.getTime() || occurred > now) continue;
    const dayKey = new Date(occurred).toISOString().slice(0, 10);
    const index = Math.floor((occurred - observedStart.getTime()) / DAY);
    const series = dailyByItem.get(movement.inventory_item_id);
    if (!series || index < 0 || index >= series.length) continue;
    const quantity = Math.abs(Number(movement.quantity ?? 0));
    if (!Number.isFinite(quantity)) throw new Error("Purchasing intelligence encountered a non-finite consumption quantity.");
    series[index] = (series[index] ?? 0) + quantity;
    const observed = observedDaysByItem.get(movement.inventory_item_id) ?? new Set<string>();
    observed.add(dayKey);
    observedDaysByItem.set(movement.inventory_item_id, observed);
  }

  const suggestions: PurchaseSuggestion[] = [];
  const reviewItems: NonNullable<PurchasingIntelligence["reviewItems"]> = [];
  let expectedMonthlySpend = 0;
  for (const item of items) {
    const evidence = stockEvidence.get(item.id);
    if (!evidence) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: "Stock-position evidence was unavailable.", observations: 0 });
      continue;
    }
    const product = bestProduct.get(item.id);
    const supplier = product ? supplierById.get(product.supplier_id) : null;
    const leadTimeRaw = product?.lead_time_days ?? supplier?.lead_time_days ?? null;
    const leadTime = leadTimeRaw == null ? null : Number(leadTimeRaw);
    if (leadTime == null || !Number.isFinite(leadTime) || leadTime < 0) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: "No valid supplier lead time is configured.", observations: observedDaysByItem.get(item.id)?.size ?? 0 });
      continue;
    }
    const horizonDays = leadTime + COVER_DAYS;
    const daily = dailyByItem.get(item.id) ?? [];
    const observedDays = observedDaysByItem.get(item.id)?.size ?? 0;
    const forecast = forecastDailyDemand(daily, horizonDays, 7, observedDays);
    if (forecast.status !== "ready" || forecast.forecastQuantity == null || forecast.dailyAverage == null) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "insufficient_history", reason: "At least seven distinct consumption days are required; no demand quantity is fabricated.", observations: observedDays });
      continue;
    }
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    const safetyValue = metadata.safety_stock_quantity ?? metadata.safetyStockQuantity ?? metadata.safety_stock;
    const safetyStock = safetyValue == null ? null : Number(safetyValue);
    if (safetyStock == null || !Number.isFinite(safetyStock) || safetyStock < 0) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: "Safety-stock quantity is not configured or is invalid.", observations: observedDays });
      continue;
    }
    const reasons = [...evidence.manualReviewReasons];
    if (!product || !supplier) reasons.push("No active supplier product with a comparable price is configured.");
    if (reasons.length > 0) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: [...new Set(reasons)].join(" "), observations: observedDays });
      continue;
    }
    const horizonEnd = new Date(now + horizonDays * DAY).toISOString();
    const stockPosition = calculateStockPosition({
      onHand: evidence.onHand,
      reservations: evidence.reservations,
      inbound: evidence.inbound,
      asOf: new Date(now).toISOString(),
      horizonEnd,
    });
    const minimumOrderQuantity = product.min_order_quantity == null ? 0 : Number(product.min_order_quantity);
    const orderMultiple = product.unit_id === item.unit_id ? Number(product.pack_size ?? 1) : 1;
    if (!Number.isFinite(minimumOrderQuantity) || minimumOrderQuantity < 0 ||
        !Number.isFinite(orderMultiple) || orderMultiple <= 0) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: "Supplier minimum quantity or order multiple is invalid.", observations: observedDays });
      continue;
    }
    const calculation = calculateReplenishment({
      forecastDemand: forecast.forecastQuantity,
      safetyStock,
      netAvailable: stockPosition.netAvailable,
      leadTimeDays: leadTime,
      targetCoverageDays: COVER_DAYS,
      stockUnitsPerPurchaseUnit: product.stockUnitsPerPurchaseUnit,
      minimumOrderQuantity,
      orderMultiple,
    });
    if (calculation.status !== "ready" || calculation.recommendedStockUnits == null || calculation.recommendedPurchaseUnits == null) {
      reviewItems.push({ inventoryItemId: item.id, name: item.name, status: "manual_review", reason: calculation.reason ?? "Replenishment calculation requires manual review.", observations: observedDays });
      continue;
    }
    const unitPrice = Number(product.effectiveUnitPrice);
    expectedMonthlySpend += forecast.dailyAverage * 30 * product.normalizedStockUnitPrice;
    if (calculation.recommendedStockUnits <= 0) continue;
    const estimatedCost = Number((calculation.recommendedPurchaseUnits * unitPrice).toFixed(2));
    suggestions.push({
      inventoryItemId: item.id,
      name: item.name,
      currentQuantity: round(stockPosition.onHand, 4),
      dailyVelocity: forecast.dailyAverage,
      leadTimeDays: leadTime,
      coverDays: COVER_DAYS,
      recommendedQuantity: calculation.recommendedStockUnits,
      estimatedCost,
      supplierName: supplier?.name ?? null,
      supplierId: supplier?.id ?? null,
      purchaseQuantity: calculation.recommendedPurchaseUnits,
      purchaseUnitId: product.unit_id,
      supplierProductId: product.id,
      purchaseUnitPrice: unitPrice,
      purchaseCurrency: product.currency,
      effectivePriceDate: product.effectivePriceDate,
      minimumOrderQuantity,
      orderMultiple,
      stockUnitsPerPurchaseUnit: product.stockUnitsPerPurchaseUnit,
      forecastDemand: forecast.forecastQuantity,
      safetyStock,
      netAvailable: stockPosition.netAvailable,
      demandObservations: forecast.observations,
      forecastConfidence: forecast.confidence,
      stockPositionEvidence: stockPosition,
    });
  }
  suggestions.sort((a, b) => b.estimatedCost - a.estimatedCost);

  const ranking: SupplierReliability[] = suppliers.map((s) => {
    const own = orders.filter((o) => o.supplier_id === s.id && o.received_at);
    const onTime = own.filter(
      (o) => !o.expected_at || o.received_at.slice(0, 10) <= o.expected_at,
    ).length;
    const leadTimes = own
      .filter((o) => o.order_date)
      .map((o) => (new Date(o.received_at).getTime() - new Date(o.order_date).getTime()) / DAY);
    const averageLead =
      leadTimes.length > 0
        ? round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length, 1)
        : null;
    const onTimePercent = own.length > 0 ? round((onTime / own.length) * 100, 1) : null;
    const declared = s.lead_time_days == null ? null : Number(s.lead_time_days);
    return {
      supplierId: s.id,
      name: s.name,
      orders: own.length,
      onTime,
      onTimePercent,
      averageLeadTimeDays: averageLead,
      declaredLeadTimeDays: declared,
      score: reliabilityScore(onTimePercent, averageLead, declared),
    };
  });
  ranking.sort((a, b) => b.score - a.score);

  const spendCost = (from: string, to?: string) =>
    moves
      .filter(
        (m) =>
          (m.movement_type === "consumption" || m.movement_type === "wastage") &&
          m.occurred_at >= from &&
          (to ? m.occurred_at < to : true),
      )
      .reduce((s, m) => s + Math.abs(Number(m.total_cost ?? 0)), 0);
  const previousMonthlySpend = spendCost(prevMonthStart, monthStart);
  const spendChange = percentChange(expectedMonthlySpend, previousMonthlySpend);

  const insights: RestaurantInsight[] = [];
  if (reviewItems.length > 0) {
    insights.push({
      key: "purchasing.manual_review",
      severity: "high",
      title: reviewItems.length + " inventory items require manual replenishment review",
      detail: reviewItems.slice(0, 5).map((row) => row.name + ": " + row.reason).join("; "),
      metric: reviewItems.length + " items",
      recommendation: "Resolve missing demand, safety-stock, supplier, unit-conversion or delivery evidence before creating purchase proposals.",
    });
  }
  if (suggestions.length > 0) {
    const top = suggestions.slice(0, 3);
    insights.push({
      key: "purchasing.suggestions",
      severity: "medium",
      title: `${suggestions.length} items should be ordered to cover forecast demand`,
      detail: top
        .map(
          (s) =>
            `${s.name} — ${s.recommendedQuantity} units (${s.dailyVelocity}/day, ${s.leadTimeDays}d lead time)`,
        )
        .join("; "),
      metric: `${currency} ${round(top.reduce((a, s) => a + s.estimatedCost, 0)).toLocaleString()} top-3 cost`,
      recommendation: "Raise purchase orders covering lead time plus a 7-day safety window.",
    });
  }
  const best = ranking.find((r) => r.orders > 0);
  const worst = [...ranking].reverse().find((r) => r.orders > 0);
  if (best && worst && best.supplierId !== worst.supplierId) {
    insights.push({
      key: "purchasing.reliability",
      severity: worst.score < 60 ? "high" : "info",
      title: `${best.name} is your most reliable supplier`,
      detail: `${best.name} scores ${best.score}/100 (${best.onTimePercent ?? 0}% on time) while ${worst.name} scores ${worst.score}/100 (${worst.onTimePercent ?? 0}% on time).`,
      metric: `${best.score} vs ${worst.score}`,
      recommendation: "Shift critical, short-shelf-life lines to the higher-scoring supplier.",
    });
  }
  if (spendChange != null) {
    insights.push({
      key: "purchasing.cost_impact",
      severity: spendChange > 15 ? "high" : spendChange > 0 ? "medium" : "info",
      title: `Expected cost impact next month: ${currency} ${round(expectedMonthlySpend).toLocaleString()}`,
      detail: `Projected from current consumption velocity and best supplier prices, versus ${currency} ${round(previousMonthlySpend).toLocaleString()} consumed last month.`,
      metric: `${spendChange > 0 ? "+" : ""}${spendChange}%`,
      recommendation:
        spendChange > 0
          ? "Re-negotiate the fastest-moving lines before the increase lands."
          : "Hold current supplier terms — projected spend is trending down.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    suggestions: suggestions.slice(0, 25),
    suppliers: ranking,
    expectedMonthlySpend: round(expectedMonthlySpend),
    previousMonthlySpend: round(previousMonthlySpend),
    spendChangePercent: spendChange,
    insights,
    reviewItems,
  };
}
