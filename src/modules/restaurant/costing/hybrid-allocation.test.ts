import { describe, expect, it } from "vitest";
import {
  allocateOperationalCost,
  AllocationError,
  assertUniqueCostSources,
  type CostSource,
} from "./hybrid-allocation";

const source: CostSource = {
  sourceId: "expense-001",
  sourceType: "operational_expense",
  tenantId: "tenant-1",
  propertyId: null,
  outletId: null,
  currency: "TZS",
  amount: 100.01,
  period: "2026-11",
};

describe("hybrid operational cost allocation", () => {
  it("preserves direct property/outlet attribution ahead of shared rules", () => {
    const result = allocateOperationalCost({
      source: { ...source, propertyId: "property-1", outletId: "outlet-1" },
      rule: {
        id: "rule-1", tenantId: "tenant-1", currency: "TZS", effectiveFrom: "2026-01",
        approved: true, version: 3,
        targets: [{ propertyId: "property-2", outletId: null, weight: 1 }],
      },
    });
    expect(result.method).toBe("direct");
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ propertyId: "property-1", outletId: "outlet-1", amount: 100.01 });
  });

  it("uses an approved matching rule and reconciles every cent", () => {
    const result = allocateOperationalCost({
      source,
      rule: {
        id: "rule-1", tenantId: "tenant-1", currency: "TZS", effectiveFrom: "2026-01",
        effectiveTo: "2026-12", approved: true, version: 2,
        targets: [
          { propertyId: "property-a", outletId: null, weight: 1 },
          { propertyId: "property-b", outletId: null, weight: 1 },
          { propertyId: "property-c", outletId: null, weight: 1 },
        ],
      },
    });
    expect(result.method).toBe("approved_rule");
    expect(result.allocations.reduce((sum, row) => sum + Math.round(row.amount * 100), 0)).toBe(10001);
    expect(result.reconciliation).toEqual({
      sourceAmount: 100.01, allocatedAmount: 100.01, unallocatedAmount: 0, balanced: true,
    });
    expect(result.allocations.every(row => row.ruleId === "rule-1" && row.ruleVersion === 2)).toBe(true);
  });

  it("rejects an unapproved rule and falls back to operational activity drivers", () => {
    const result = allocateOperationalCost({
      source,
      rule: {
        id: "draft", tenantId: "tenant-1", currency: "TZS", effectiveFrom: "2026-01",
        approved: false, version: 1,
        targets: [{ propertyId: "property-a", outletId: null, weight: 1 }],
      },
      drivers: [
        { propertyId: "property-a", outletId: "outlet-a", units: 3 },
        { propertyId: "property-b", outletId: "outlet-b", units: 1 },
      ],
    });
    expect(result.method).toBe("activity_driver");
    expect(result.allocations.map(row => row.amount)).toEqual([75.01, 25]);
  });

  it("keeps missing attribution visible as an unallocated exception", () => {
    const result = allocateOperationalCost({ source });
    expect(result.method).toBe("unallocated");
    expect(result.allocations).toEqual([]);
    expect(result.unallocatedAmount).toBe(100.01);
    expect(result.reconciliation.balanced).toBe(true);
  });

  it("requires an explicitly approved manual allocation to reconcile exactly", () => {
    expect(() => allocateOperationalCost({
      source,
      manual: [{ propertyId: "property-a", outletId: null, amount: 90, approvedBy: "manager-1" }],
    })).toThrow(AllocationError);
    const result = allocateOperationalCost({
      source,
      manual: [
        { propertyId: "property-a", outletId: null, amount: 60, approvedBy: "manager-1" },
        { propertyId: "property-b", outletId: null, amount: 40.01, approvedBy: "manager-1" },
      ],
    });
    expect(result.method).toBe("manual");
    expect(result.reconciliation.balanced).toBe(true);
  });

  it("rejects cross-tenant, wrong-currency and expired allocation rules", () => {
    for (const override of [
      { tenantId: "other-tenant" },
      { currency: "USD" },
      { effectiveTo: "2026-10" },
    ]) {
      const result = allocateOperationalCost({
        source,
        rule: {
          id: "rule", tenantId: "tenant-1", currency: "TZS", effectiveFrom: "2026-01",
          approved: true, version: 1,
          targets: [{ propertyId: "property-a", outletId: null, weight: 1 }],
          ...override,
        },
      });
      expect(result.method).toBe("unallocated");
    }
  });

  it("rejects invalid amounts, invalid driver weights and duplicate source recognition", () => {
    expect(() => allocateOperationalCost({ source: { ...source, amount: -1 } })).toThrow(AllocationError);
    expect(() => allocateOperationalCost({
      source,
      drivers: [{ propertyId: "property-a", outletId: null, units: 0 }],
    })).toThrow(AllocationError);
    expect(() => assertUniqueCostSources([source, source])).toThrow(/Duplicate cost source/);
    expect(() => assertUniqueCostSources([
      source, { ...source, sourceType: "operational_consumption" },
    ])).not.toThrow();
  });
});
