/**
 * Canonical, deterministic inventory-position and replenishment contracts.
 *
 * This module is pure: it does not query or mutate inventory, procurement,
 * reservation, transfer, or ledger records. Server services must supply
 * evidence from the canonical operational tables and preserve its provenance.
 */

export type EvidenceStatus = "ready" | "insufficient_history" | "manual_review";

export interface InboundCommitment {
  sourceId: string;
  sourceType: "purchase_order" | "supplier_confirmation" | "stock_transfer";
  quantityInStockUnits: number;
  expectedAt: string | null;
  status: string;
  acceptedQuantityInStockUnits?: number;
  rejectedQuantityInStockUnits?: number;
}

export interface StockPositionEvidence {
  onHand: number;
  reserved: number;
  purchaseOrderInbound: number;
  confirmedDeliveryInbound: number;
  inTransitInbound: number;
  netAvailable: number;
  components: Array<{
    sourceId: string;
    sourceType: InboundCommitment["sourceType"];
    quantityInStockUnits: number;
    expectedAt: string | null;
  }>;
}

export interface StockPositionInput {
  onHand: number;
  reservations: Array<{ id: string; quantity: number; status: string; expiresAt: string | null }>;
  inbound: InboundCommitment[];
  asOf: string;
  horizonEnd: string;
}

const finite = (value: number): boolean => Number.isFinite(value);
const nonNegative = (value: number): boolean => finite(value) && value >= 0;

/**
 * A reservation is active only while status=active and it has not expired.
 * A null expiry is an intentionally open-ended reservation.
 */
export function activeReservedQuantity(
  reservations: StockPositionInput["reservations"],
  asOf: string,
): number {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("Invalid stock-position as-of timestamp.");
  return reservations.reduce((sum, reservation) => {
    if (reservation.status !== "active") return sum;
    const quantity = Number(reservation.quantity);
    if (!nonNegative(quantity)) throw new Error("Invalid reservation quantity.");
    if (reservation.expiresAt) {
      const expiry = Date.parse(reservation.expiresAt);
      if (!Number.isFinite(expiry)) throw new Error("Invalid reservation expiry timestamp.");
      if (expiry <= now) return sum;
    }
    return sum + quantity;
  }, 0);
}

/**
 * Calculates net stock without counting accepted receipts twice. Accepted
 * receipts already enter on-hand through the stock ledger. Rejected/damaged
 * goods never become available. A commitment without a valid expected date
 * is excluded because its arrival cannot be proven to fall inside the horizon.
 */
export function calculateStockPosition(input: StockPositionInput): StockPositionEvidence {
  const onHand = Number(input.onHand);
  if (!finite(onHand)) throw new Error("Invalid on-hand quantity.");
  const asOf = Date.parse(input.asOf);
  const horizonEnd = Date.parse(input.horizonEnd);
  if (!Number.isFinite(asOf) || !Number.isFinite(horizonEnd) || horizonEnd < asOf) {
    throw new Error("Invalid stock-position horizon.");
  }

  const reserved = activeReservedQuantity(input.reservations, input.asOf);
  let purchaseOrderInbound = 0;
  let confirmedDeliveryInbound = 0;
  let inTransitInbound = 0;
  const components: StockPositionEvidence["components"] = [];

  for (const commitment of input.inbound) {
    if (!nonNegative(commitment.quantityInStockUnits)) {
      throw new Error("Invalid inbound commitment quantity.");
    }
    if (commitment.status === "cancelled" || commitment.status === "declined" || commitment.status === "rejected" || commitment.status === "received" || commitment.status === "completed") {
      continue;
    }
    if (!commitment.expectedAt) continue;
    const expected = Date.parse(commitment.expectedAt);
    if (!Number.isFinite(expected)) throw new Error("Invalid inbound expected-delivery timestamp.");
    if (expected < asOf || expected > horizonEnd) continue;

    const quantity = commitment.quantityInStockUnits;
    if (quantity <= 0) continue;
    if (commitment.sourceType === "purchase_order") purchaseOrderInbound += quantity;
    else if (commitment.sourceType === "supplier_confirmation") confirmedDeliveryInbound += quantity;
    else if (commitment.sourceType === "stock_transfer") inTransitInbound += quantity;

    components.push({
      sourceId: commitment.sourceId,
      sourceType: commitment.sourceType,
      quantityInStockUnits: quantity,
      expectedAt: commitment.expectedAt,
    });
  }

  return {
    onHand,
    reserved,
    purchaseOrderInbound,
    confirmedDeliveryInbound,
    inTransitInbound,
    netAvailable: onHand - reserved + purchaseOrderInbound + confirmedDeliveryInbound + inTransitInbound,
    components: components.sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId) || a.sourceType.localeCompare(b.sourceType),
    ),
  };
}

export interface DailyDemandForecast {
  status: EvidenceStatus;
  observations: number;
  dailyAverage: number | null;
  forecastQuantity: number | null;
  horizonDays: number;
  confidence: "high" | "medium" | "low" | "none";
  outlierDays: number[];
  method: "winsorized_daily_mean";
}

/**
 * Forecasts from a complete daily series (including zero-consumption days).
 * At least seven observed days are required. A 95th-percentile winsorization
 * limits isolated spikes without discarding the underlying observations.
 */
export function forecastDailyDemand(
  dailyConsumption: number[],
  horizonDays: number,
  minimumObservations = 7,
  observedDays = dailyConsumption.length,
): DailyDemandForecast {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new Error("Forecast horizon must be a positive integer.");
  }
  if (!Number.isInteger(minimumObservations) || minimumObservations < 1) {
    throw new Error("Minimum demand observations must be a positive integer.");
  }
  if (!Number.isInteger(observedDays) || observedDays < 0) {
    throw new Error("Observed demand days must be a non-negative integer.");
  }
  const values = dailyConsumption.map(Number);
  if (values.some((value) => !nonNegative(value))) {
    throw new Error("Demand observations must be finite and non-negative.");
  }
  if (values.length < minimumObservations || observedDays < minimumObservations) {
    return {
      status: "insufficient_history",
      observations: observedDays,
      dailyAverage: null,
      forecastQuantity: null,
      horizonDays,
      confidence: "none",
      outlierDays: [],
      method: "winsorized_daily_mean",
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const capIndex = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
  const cap = sorted[Math.max(0, capIndex)] ?? 0;
  const outlierDays: number[] = [];
  const winsorized = values.map((value, index) => {
    if (value > cap) {
      outlierDays.push(index);
      return cap;
    }
    return value;
  });
  const dailyAverage = winsorized.reduce((sum, value) => sum + value, 0) / winsorized.length;
  const confidence = observedDays >= 21 ? "high" : observedDays >= 14 ? "medium" : "low";
  return {
    status: "ready",
    observations: observedDays,
    dailyAverage: Number(dailyAverage.toFixed(4)),
    forecastQuantity: Number((dailyAverage * horizonDays).toFixed(4)),
    horizonDays,
    confidence,
    outlierDays,
    method: "winsorized_daily_mean",
  };
}

export interface ReplenishmentCalculationInput {
  forecastDemand: number;
  safetyStock: number;
  netAvailable: number;
  leadTimeDays: number | null;
  targetCoverageDays: number;
  stockUnitsPerPurchaseUnit: number | null;
  minimumOrderQuantity?: number | null;
  orderMultiple?: number | null;
}

export interface ReplenishmentCalculation {
  status: EvidenceStatus;
  horizonDays: number | null;
  forecastDemand: number;
  safetyStock: number;
  netAvailable: number;
  requiredStockUnits: number | null;
  recommendedPurchaseUnits: number | null;
  recommendedStockUnits: number | null;
  reason: string | null;
}

/** Converts a stock-unit requirement into configured, indivisible supplier packs. */
export function calculateReplenishment(
  input: ReplenishmentCalculationInput,
): ReplenishmentCalculation {
  const numericValues = [input.forecastDemand, input.safetyStock, input.netAvailable, input.targetCoverageDays];
  if (numericValues.some((value) => !finite(value)) || input.forecastDemand < 0 || input.safetyStock < 0 || input.targetCoverageDays < 0) {
    throw new Error("Invalid replenishment calculation input.");
  }
  if (input.leadTimeDays == null || !finite(input.leadTimeDays) || input.leadTimeDays < 0) {
    return {
      status: "manual_review",
      horizonDays: null,
      forecastDemand: input.forecastDemand,
      safetyStock: input.safetyStock,
      netAvailable: input.netAvailable,
      requiredStockUnits: null,
      recommendedPurchaseUnits: null,
      recommendedStockUnits: null,
      reason: "Supplier lead time is missing or invalid.",
    };
  }
  const horizonDays = input.leadTimeDays + input.targetCoverageDays;
  const requirement = Math.max(0, input.forecastDemand + input.safetyStock - input.netAvailable);
  if (requirement === 0) {
    return {
      status: "ready",
      horizonDays,
      forecastDemand: input.forecastDemand,
      safetyStock: input.safetyStock,
      netAvailable: input.netAvailable,
      requiredStockUnits: 0,
      recommendedPurchaseUnits: 0,
      recommendedStockUnits: 0,
      reason: null,
    };
  }
  const pack = input.stockUnitsPerPurchaseUnit;
  if (pack == null || !finite(pack) || pack <= 0) {
    return {
      status: "manual_review",
      horizonDays,
      forecastDemand: input.forecastDemand,
      safetyStock: input.safetyStock,
      netAvailable: input.netAvailable,
      requiredStockUnits: requirement,
      recommendedPurchaseUnits: null,
      recommendedStockUnits: null,
      reason: "Supplier purchase unit cannot be converted to the stock unit.",
    };
  }
  const minimum = input.minimumOrderQuantity ?? 0;
  const multiple = input.orderMultiple ?? 1;
  if (!nonNegative(minimum) || !finite(multiple) || multiple <= 0) {
    return {
      status: "manual_review",
      horizonDays,
      forecastDemand: input.forecastDemand,
      safetyStock: input.safetyStock,
      netAvailable: input.netAvailable,
      requiredStockUnits: requirement,
      recommendedPurchaseUnits: null,
      recommendedStockUnits: null,
      reason: "Supplier minimum order quantity or order multiple is invalid.",
    };
  }
  const rawPurchaseUnits = Math.max(requirement / pack, minimum);
  const purchaseUnits = Math.ceil(rawPurchaseUnits / multiple) * multiple;
  const recommendedStockUnits = purchaseUnits * pack;
  return {
    status: "ready",
    horizonDays,
    forecastDemand: input.forecastDemand,
    safetyStock: input.safetyStock,
    netAvailable: input.netAvailable,
    requiredStockUnits: Number(requirement.toFixed(4)),
    recommendedPurchaseUnits: Number(purchaseUnits.toFixed(4)),
    recommendedStockUnits: Number(recommendedStockUnits.toFixed(4)),
    reason: null,
  };
}

export function comparableSupplierUnitCost(
  unitPrice: number,
  currency: string,
  expectedCurrency: string,
  stockUnitsPerPurchaseUnit: number,
): number | null {
  if (!finite(unitPrice) || unitPrice < 0 || !currency || currency !== expectedCurrency) return null;
  if (!finite(stockUnitsPerPurchaseUnit) || stockUnitsPerPurchaseUnit <= 0) return null;
  return Number((unitPrice / stockUnitsPerPurchaseUnit).toFixed(6));
}

export interface InventoryUnitEvidence {
  id: string;
  dimension: string;
  base_unit_id: string | null;
  factor: number;
}

/**
 * Resolves a configured purchase-unit conversion to stock units. Unit factors
 * are used only when dimensions and base units match; the explicit item pack
 * mapping is the sole fallback. Unknown or incompatible units fail closed.
 */
export function stockUnitsPerUnit(
  sourceUnitId: string | null,
  stockUnitId: string | null,
  purchaseUnitId: string | null,
  configuredPackSize: number | null,
  units: readonly InventoryUnitEvidence[],
): number | null {
  if (!sourceUnitId || !stockUnitId) return null;
  if (sourceUnitId === stockUnitId) return 1;
  const source = units.find((unit) => unit.id === sourceUnitId);
  const stock = units.find((unit) => unit.id === stockUnitId);
  if (source && stock && source.dimension === stock.dimension && source.base_unit_id === stock.base_unit_id) {
    const sourceFactor = Number(source.factor);
    const stockFactor = Number(stock.factor);
    if (finite(sourceFactor) && finite(stockFactor) && sourceFactor > 0 && stockFactor > 0) {
      return Number((sourceFactor / stockFactor).toFixed(8));
    }
  }
  if (sourceUnitId === purchaseUnitId && configuredPackSize != null) {
    const pack = Number(configuredPackSize);
    return finite(pack) && pack > 0 ? pack : null;
  }
  return null;
}
