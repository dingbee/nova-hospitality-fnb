import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  getTenantScope: vi.fn(),
  resolveMultiPropertyScope: vi.fn(),
  getPurchasingIntelligence: vi.fn(),
  resolveTenantCurrency: vi.fn(),
  createPurchaseOrder: vi.fn(),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
  getTenantScope: (...args: unknown[]) => mocks.getTenantScope(...args),
  resolveMultiPropertyScope: (...args: unknown[]) => mocks.resolveMultiPropertyScope(...args),
}));

vi.mock("../intelligence/purchasing.server", () => ({
  getPurchasingIntelligence: (...args: unknown[]) => mocks.getPurchasingIntelligence(...args),
}));

vi.mock("../prepare/resolve.server", () => ({
  resolveTenantCurrency: (...args: unknown[]) => mocks.resolveTenantCurrency(...args),
}));

vi.mock("../purchasing/purchasing.server", () => ({
  createPurchaseOrder: (...args: unknown[]) => mocks.createPurchaseOrder(...args),
  transitionPurchaseOrder: vi.fn(),
}));

import { createIntelligentPurchaseOrders } from "./ask-lexibite.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const SUPPLIER = "44444444-4444-4444-8444-444444444444";
const PRODUCT = "55555555-5555-4555-8555-555555555555";
const UNIT = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY = "77777777-7777-4777-8777-777777777777";

function chain(result: unknown) {
  const q: any = {};
  for (const method of ["select", "eq", "in", "maybeSingle", "single"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result));
  return q;
}

function sbWithExisting(existing: unknown) {
  return {
    from: vi.fn((table: string) => {
      if (table === "restaurant_inventory_items") {
        return chain({
          data: [{
            id: ITEM,
            name: "Beef",
            unit_id: UNIT,
            property_id: null,
            location_id: null,
            currency: "TZS",
          }],
          error: null,
        });
      }
      if (table === "restaurant_supplier_products") {
        return chain({
          data: [{
            id: PRODUCT,
            supplier_id: SUPPLIER,
            inventory_item_id: ITEM,
            unit_id: UNIT,
            unit_price: 12000,
            active: true,
          }],
          error: null,
        });
      }
      if (table === "restaurant_suppliers") {
        return chain({ data: [{ id: SUPPLIER, name: "Fresh Supplier" }], error: null });
      }
      if (table === "restaurant_purchase_orders") {
        return chain({ data: existing, error: null });
      }
      if (table === "restaurant_purchase_order_items") {
        return chain({ data: existing ? [{ id: "line-1" }] : [], error: null });
      }
      return chain({ data: [], error: null });
    }),
  } as any;
}

describe("IA-BRIDGE-01 intelligent PO quantity binding", () => {
  it("persists the Purchasing Intelligence quantity and a line override as the actual PO line quantity", async () => {
    mocks.assertCapability.mockResolvedValue(undefined);
    mocks.getTenantScope.mockResolvedValue({});
    mocks.resolveMultiPropertyScope.mockResolvedValue(null);
    mocks.resolveTenantCurrency.mockResolvedValue("TZS");
    mocks.getPurchasingIntelligence.mockResolvedValue({
      generatedAt: "2026-10-05T00:00:00.000Z",
      windowDays: 30,
      currency: "TZS",
      suggestions: [{
        inventoryItemId: ITEM,
        name: "Beef",
        supplierId: SUPPLIER,
        supplierName: "Fresh Supplier",
        recommendedQuantity: 10,
        estimatedCost: 120000,
        currentQuantity: 2,
        dailyVelocity: 1,
        leadTimeDays: 2,
        coverDays: 5,
      }],
      suppliers: [],
      spendChangePercent: null,
      expectedMonthlySpend: 0,
      previousMonthlySpend: 0,
    });
    mocks.createPurchaseOrder.mockResolvedValue({
      id: "po-1",
      document_number: "PO-1",
      status: "draft",
      total: 96000,
      currency: "TZS",
    });

    const sb = sbWithExisting(null);
    await createIntelligentPurchaseOrders(sb, USER, {
      tenantId: TENANT,
      inventoryItemIds: [],
      supplierId: null,
      idempotencyKey: IDEMPOTENCY,
      lineOverrides: [{ inventoryItemId: ITEM, quantity: 8 }],
    });

    expect(mocks.createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(mocks.createPurchaseOrder.mock.calls[0][2].lines).toEqual([
      expect.objectContaining({ inventoryItemId: ITEM, quantity: 8, unitPrice: 12000 }),
    ]);
  });

  it("uses the intelligence recommendation unchanged when no override is supplied", async () => {
    mocks.getPurchasingIntelligence.mockResolvedValue({
      generatedAt: "2026-10-05T00:00:00.000Z",
      windowDays: 30,
      currency: "TZS",
      suggestions: [{
        inventoryItemId: ITEM,
        name: "Beef",
        supplierId: SUPPLIER,
        supplierName: "Fresh Supplier",
        recommendedQuantity: 10,
        estimatedCost: 120000,
        currentQuantity: 2,
        dailyVelocity: 1,
        leadTimeDays: 2,
        coverDays: 5,
      }],
      suppliers: [],
      spendChangePercent: null,
      expectedMonthlySpend: 0,
      previousMonthlySpend: 0,
    });
    mocks.createPurchaseOrder.mockResolvedValue({
      id: "po-2",
      document_number: "PO-2",
      status: "draft",
      total: 120000,
      currency: "TZS",
    });

    const sb = sbWithExisting(null);
    await createIntelligentPurchaseOrders(sb, USER, {
      tenantId: TENANT,
      inventoryItemIds: [],
      supplierId: null,
      idempotencyKey: IDEMPOTENCY,
      lineOverrides: [],
    });

    expect(mocks.createPurchaseOrder.mock.calls.at(-1)?.[2].lines[0].quantity).toBe(10);
  });

  it("recovers an existing intelligent PO on retry without creating a second PO", async () => {
    mocks.getPurchasingIntelligence.mockResolvedValue({
      generatedAt: "2026-10-05T00:00:00.000Z",
      windowDays: 30,
      currency: "TZS",
      suggestions: [{
        inventoryItemId: ITEM,
        name: "Beef",
        supplierId: SUPPLIER,
        supplierName: "Fresh Supplier",
        recommendedQuantity: 10,
        estimatedCost: 120000,
        currentQuantity: 2,
        dailyVelocity: 1,
        leadTimeDays: 2,
        coverDays: 5,
      }],
      suppliers: [],
      spendChangePercent: null,
      expectedMonthlySpend: 0,
      previousMonthlySpend: 0,
    });
    mocks.createPurchaseOrder.mockClear();

    const existing = {
      id: "po-existing",
      document_number: "PO-EXISTING",
      reference: "LEXI-INT-existing",
      status: "draft",
      supplier_id: SUPPLIER,
      property_id: null,
      location_id: null,
      total: 120000,
      currency: "TZS",
    };
    const sb = sbWithExisting(existing);

    const result = await createIntelligentPurchaseOrders(sb, USER, {
      tenantId: TENANT,
      inventoryItemIds: [],
      supplierId: null,
      idempotencyKey: IDEMPOTENCY,
      lineOverrides: [],
    });

    expect(mocks.createPurchaseOrder).not.toHaveBeenCalled();
    expect(result.created[0]).toMatchObject({
      id: "po-existing",
      status: "draft",
      lineCount: 1,
    });
  });
});
