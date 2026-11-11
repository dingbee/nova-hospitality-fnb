import { describe, expect, it } from "vitest";
import { detectOperationalAnomalies } from "./operational-anomalies";

describe("LB-04 operational anomaly rules", () => {
  it("detects stale sources, negative stock, payment variance and unverified mappings", () => {
    const result = detectOperationalAnomalies({
      propertyId: "p1",
      source: "lexibite",
      observedAt: "2026-11-10T10:00:00Z",
      now: "2026-11-10T12:00:00Z",
      freshnessSlaMinutes: 30,
      stockOnHand: -2,
      allowNegativeStock: false,
      orderTotal: 100,
      capturedPaymentTotal: 90,
      mappingVerified: false,
    });
    expect(result.map((row) => row.code)).toEqual([
      "source_stale",
      "negative_stock",
      "payment_total_mismatch",
      "property_mapping_missing",
    ]);
  });

  it("does not report expected negative stock or balanced payments", () => {
    const result = detectOperationalAnomalies({
      propertyId: "p1",
      source: "lexibite",
      observedAt: "2026-11-10T11:55:00Z",
      now: "2026-11-10T12:00:00Z",
      freshnessSlaMinutes: 30,
      stockOnHand: -2,
      allowNegativeStock: true,
      orderTotal: 100,
      capturedPaymentTotal: 100.005,
      paymentTolerance: 0.01,
      mappingVerified: true,
      sourceCurrency: "TZS",
      propertyCurrency: "TZS",
    });
    expect(result).toEqual([]);
  });

  it("blocks mixed-currency aggregation", () => {
    const result = detectOperationalAnomalies({
      propertyId: "p1",
      source: "lexibite",
      observedAt: null,
      now: "2026-11-10T12:00:00Z",
      mappingVerified: true,
      sourceCurrency: "USD",
      propertyCurrency: "TZS",
    });
    expect(result[0]?.code).toBe("currency_mismatch");
  });
});
