/**
 * LB-04 deterministic operational anomaly rules.
 * Rules emit explainable evidence; they never alter source records.
 */
export type OperationalAnomalyCode =
  | "source_stale"
  | "negative_stock"
  | "stock_movement_direction_mismatch"
  | "payment_total_mismatch"
  | "property_mapping_missing"
  | "currency_mismatch";

export interface OperationalEvidence {
  propertyId: string;
  source: string;
  observedAt: string | null;
  now: string;
  freshnessSlaMinutes?: number;
  stockOnHand?: number;
  allowNegativeStock?: boolean;
  movementType?: string;
  movementQuantity?: number;
  orderTotal?: number;
  capturedPaymentTotal?: number;
  paymentTolerance?: number;
  mappingVerified?: boolean;
  sourceCurrency?: string;
  propertyCurrency?: string;
}

export interface OperationalAnomaly {
  code: OperationalAnomalyCode;
  severity: "warning" | "critical";
  propertyId: string;
  source: string;
  observedValue: string | number | null;
  expectedValue: string | number | null;
  rationale: string;
}

export function detectOperationalAnomalies(input: OperationalEvidence): OperationalAnomaly[] {
  const anomalies: OperationalAnomaly[] = [];
  const add = (
    code: OperationalAnomalyCode,
    severity: OperationalAnomaly["severity"],
    observedValue: string | number | null,
    expectedValue: string | number | null,
    rationale: string,
  ) => anomalies.push({ code, severity, propertyId: input.propertyId, source: input.source, observedValue, expectedValue, rationale });

  if (input.observedAt !== null && input.freshnessSlaMinutes !== undefined) {
    const observed = Date.parse(input.observedAt);
    const now = Date.parse(input.now);
    if (Number.isFinite(observed) && Number.isFinite(now) && now >= observed) {
      const ageMinutes = (now - observed) / 60000;
      if (ageMinutes > input.freshnessSlaMinutes) {
        add("source_stale", "warning", ageMinutes, input.freshnessSlaMinutes, "Source update age exceeds the configured freshness SLA.");
      }
    }
  }
  if (input.stockOnHand !== undefined && input.stockOnHand < 0 && input.allowNegativeStock !== true) {
    add("negative_stock", "critical", input.stockOnHand, 0, "Negative stock is recorded while negative inventory is not permitted.");
  }
  if (input.movementType !== undefined && input.movementQuantity !== undefined) {
    const outbound = new Set(["consumption", "wastage", "transfer_out", "return_to_supplier", "adjustment_out"]);
    const inbound = new Set(["purchase_receipt", "transfer_in", "adjustment_in"]);
    const expectedSign = outbound.has(input.movementType) ? -1 : inbound.has(input.movementType) ? 1 : 0;
    if ((expectedSign < 0 && input.movementQuantity > 0) ||
        (expectedSign > 0 && input.movementQuantity < 0)) {
      add(
        "stock_movement_direction_mismatch",
        "critical",
        input.movementQuantity,
        expectedSign < 0 ? "negative" : "positive",
        "Stock movement quantity sign conflicts with its movement type; usage and replenishment calculations must not normalise it silently.",
      );
    }
  }
  if (input.orderTotal !== undefined && input.capturedPaymentTotal !== undefined) {
    const tolerance = input.paymentTolerance ?? 0.01;
    if (Math.abs(input.orderTotal - input.capturedPaymentTotal) > tolerance) {
      add("payment_total_mismatch", "critical", input.capturedPaymentTotal, input.orderTotal, "Captured payment total differs from the order total beyond the configured tolerance.");
    }
  }
  if (input.mappingVerified === false) {
    add("property_mapping_missing", "critical", false, true, "Cross-product analytics are blocked until the property mapping is verified.");
  }
  if (input.sourceCurrency !== undefined && input.propertyCurrency !== undefined &&
      input.sourceCurrency !== input.propertyCurrency) {
    add("currency_mismatch", "critical", input.sourceCurrency, input.propertyCurrency, "Source and property currencies differ; cross-currency aggregation is blocked.");
  }
  return anomalies;
}
