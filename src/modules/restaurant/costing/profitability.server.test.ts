import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeProfitability } from "./profitability.server";

vi.mock("../core/access.server", () => ({
  accessibleLocationIds: vi.fn(),
  assertCapability: vi.fn().mockResolvedValue(undefined),
  assertTenantRead: vi.fn().mockResolvedValue(undefined),
  getTenantScope: vi.fn().mockResolvedValue({ tenantId: "10000000-0000-0000-0000-000000000001" }),
  NO_MATCH_ID: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn().mockResolvedValue(undefined),
}));

const tenantId = "10000000-0000-0000-0000-000000000001";
const input = {
  tenantId,
  from: "2026-11-01T00:00:00.000Z",
  to: "2026-11-30T23:59:59.999Z",
  persist: false,
  limit: 100,
};

function makeSupabase(data: Record<string, unknown[]>, persisted?: unknown[][]) {
  return {
    from(table: string) {
      let inserted: unknown[] | null = null;
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        delete: () => query,
        single: () => Promise.resolve({ data: { id: "snapshot-1" }, error: null }),
        insert: (rows: unknown[]) => {
          inserted = rows;
          persisted?.push(rows);
          return query;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: inserted ? null : data[table] ?? (table === "restaurant_properties" ? [{ id: "property-1", currency: "TZS" }] : []), error: null }).then(resolve, reject),
      };
      return query;
    },
  };
}

describe("computeProfitability operating-cost integration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes allocated operating costs when the period has no sales", async () => {
    const sb = makeSupabase({
      restaurant_orders: [],
      restaurant_cost_allocations: [{ amount: 125000, currency: "TZS", property_id: "property-1", period_start: "2026-11-01" }],
    });
    const result = await computeProfitability(sb, "user-1", input);
    expect(result.rows).toEqual([]);
    expect(result.totals).toMatchObject({
      revenue: 0,
      allocated_operating_expenses: 125000,
      contribution_profit: 0,
      contribution_margin_percent: null,
      operating_profit: -125000,
      operating_margin_percent: null,
      currency: "TZS",
    });
  });

  it("calculates contribution profit from all rows, not only the displayed page, and persists the full snapshot", async () => {
    const persisted: unknown[][] = [];
    const sb = makeSupabase({
      restaurant_orders: [{ id: "order-1", currency: "TZS", property_id: "property-1", location_id: "outlet-1", source: "pos" }],
      restaurant_cost_allocations: [{ amount: 10000, currency: "TZS", property_id: "property-1", period_start: "2026-11-01" }],
      restaurant_order_items: [
        { id: "line-1", order_id: "order-1", menu_item_id: "menu-1", description: "Pilau", quantity: 2, line_total: 30000, line_cost: 10000, status: "served" },
        { id: "line-2", order_id: "order-1", menu_item_id: "menu-2", description: "Juice", quantity: 1, line_total: 10000, line_cost: 3000, status: "served" },
      ],
      restaurant_stock_movements: [
        { id: "movement-1", order_item_id: "line-1", total_cost: 12000, currency: "TZS" },
        { id: "movement-2", order_item_id: "line-2", total_cost: 4000, currency: "TZS" },
      ],
    }, persisted);
    const result = await computeProfitability(sb, "user-1", { ...input, persist: true, limit: 1, propertyId: "property-1" });
    expect(result.rows).toHaveLength(1);
    expect(result.totals).toMatchObject({
      quantity_sold: 3,
      revenue: 40000,
      theoretical_cost: 13000,
      actual_cost: 16000,
      variance: 3000,
      gross_profit: 24000,
      allocated_operating_expenses: 10000,
      contribution_profit: 24000,
      contribution_margin_percent: 60,
      operating_profit: 14000,
      operating_margin_percent: 35,
    });
    expect(persisted).toHaveLength(3);
    expect(persisted[0]).toHaveLength(2);
    expect(persisted[1]).toMatchObject({ tenant_id: tenantId, currency: "TZS", confidence_state: "incomplete_source_data" });
    expect(persisted[2]).toHaveLength(3);
  });

  it("nets refunds and tax while including classified service consumables exactly once", async () => {
    const sb = makeSupabase({
      restaurant_orders: [{
        id: "order-1", currency: "TZS", property_id: "property-1",
        location_id: "outlet-1", source: "pos", total: 1100,
        discount_total: 100, tax_total: 100, service_charge: 0,
      }],
      restaurant_order_items: [{
        id: "line-1", order_id: "order-1", menu_item_id: "menu-1", description: "Pilau",
        quantity: 1, line_total: 1100, line_cost: 400, discount: 100, tax_amount: 100,
        status: "served", is_comp: false, channel: "pos",
      }],
      restaurant_stock_movements: [
        { id: "recipe-movement", order_item_id: "line-1", inventory_item_id: "rice", property_id: "property-1", location_id: "outlet-1", total_cost: 400, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-1" },
        { id: "napkin-movement", order_item_id: "line-1", inventory_item_id: "napkin", property_id: "property-1", location_id: "outlet-1", total_cost: 50, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-1" },
      ],
      restaurant_payments: [{
        id: "refund-1", order_id: "order-1", amount: -550, state: "refunded",
        refund_of: "payment-1", currency: "TZS",
      }],
      restaurant_consumption_profiles: [{
        id: "profile-1", cost_class: "service_consumable", property_id: "property-1",
        location_id: null, effective_from: "2025-01-01", effective_to: null, active: true,
      }],
      restaurant_consumption_rules: [{
        id: "rule-1", profile_id: "profile-1", inventory_item_id: "napkin", quantity_per_cover: 1,
        effective_from: "2025-01-01", effective_to: null, active: true,
      }],
      restaurant_consumption_events: [{
        id: "event-1", stock_movement_id: "napkin-movement", order_id: "order-1",
        order_item_id: "line-1", cost_class: "service_consumable", total_cost: 50, currency: "TZS",
      }],
    });
    const result = await computeProfitability(sb, "user-1", input);
    expect(result.operational).toMatchObject({
      grossSales: 1200,
      discounts: 100,
      refunds: 550,
      taxCollected: 50,
      netSales: 500,
      recipeCogs: 400,
      serviceConsumables: 50,
      directVariableCosts: 450,
      contribution: 50,
      operatingProfit: 50,
      reconciliationState: "partially_reconciled",
      salesAdjustments: 0,
    });
    expect(result.totals.actual_cost).toBe(450);
    expect(result.dimensions).toHaveLength(3);
  });

  it("recognises a fully refunded original payment without requiring a child refund row", async () => {
    const sb = makeSupabase({
      restaurant_orders: [{
        id: "order-1", currency: "TZS", property_id: "property-1",
        location_id: "outlet-1", source: "pos", total: 1100,
        discount_total: 100, tax_total: 100, service_charge: 0,
      }],
      restaurant_order_items: [{
        id: "line-1", order_id: "order-1", menu_item_id: "menu-1",
        description: "Pilau", quantity: 1, line_total: 1100, line_cost: 0,
        discount: 100, tax_amount: 100, status: "served", is_comp: false,
        channel: "pos",
      }],
      restaurant_payments: [
        {
          id: "payment-1", order_id: "order-1", amount: 1100,
          state: "refunded", refund_of: null, currency: "TZS",
        },
        {
          id: "refund-1", order_id: "order-1", amount: -1100,
          state: "refunded", refund_of: "payment-1", currency: "TZS",
        },
      ],
    });
    const result = await computeProfitability(sb, "user-1", input);
    expect(result.operational).toMatchObject({
      grossSales: 1200,
      discounts: 100,
      refunds: 1100,
      salesAdjustments: 0,
      taxCollected: 0,
      netSales: 0,
    });
  });

  it("allocates property and outlet OPEX without double counting and marks channel attribution estimated", async () => {
    const sb = makeSupabase({
      restaurant_orders: [
        { id: "order-pos", currency: "TZS", property_id: "property-1", location_id: "outlet-1", source: "pos", total: 80, discount_total: 0, tax_total: 0, service_charge: 0 },
        { id: "order-delivery", currency: "TZS", property_id: "property-1", location_id: "outlet-2", source: "delivery", total: 20, discount_total: 0, tax_total: 0, service_charge: 0 },
      ],
      restaurant_order_items: [
        { id: "line-pos", order_id: "order-pos", menu_item_id: "menu-1", description: "Rice", quantity: 1, line_total: 80, line_cost: 10, discount: 0, tax_amount: 0, service_charge_amount: 0, status: "served", is_comp: false, channel: "pos" },
        { id: "line-delivery", order_id: "order-delivery", menu_item_id: "menu-1", description: "Rice", quantity: 1, line_total: 20, line_cost: 10, discount: 0, tax_amount: 0, service_charge_amount: 0, status: "served", is_comp: false, channel: "delivery" },
      ],
      restaurant_stock_movements: [
        { id: "movement-pos", order_item_id: "line-pos", inventory_item_id: "rice-pos", property_id: "property-1", location_id: "outlet-1", total_cost: 10, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-pos", reason: "Recipe consumption" },
        { id: "movement-delivery", order_item_id: "line-delivery", inventory_item_id: "rice-delivery", property_id: "property-1", location_id: "outlet-2", total_cost: 10, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-delivery", reason: "Recipe consumption" },
        { id: "napkin-pos", order_item_id: null, inventory_item_id: "napkin", property_id: "property-1", location_id: "outlet-1", total_cost: 0, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-pos", reason: "Operational service consumable" },
        { id: "napkin-delivery", order_item_id: null, inventory_item_id: "napkin", property_id: "property-1", location_id: "outlet-2", total_cost: 0, currency: "TZS", reference_type: "restaurant_order", reference_id: "order-delivery", reason: "Operational service consumable" },
      ],
      restaurant_consumption_events: [
        { id: "event-pos", stock_movement_id: "napkin-pos", order_id: "order-pos", cost_class: "service_consumable", total_cost: 0, currency: "TZS" },
        { id: "event-delivery", stock_movement_id: "napkin-delivery", order_id: "order-delivery", cost_class: "service_consumable", total_cost: 0, currency: "TZS" },
      ],
      restaurant_cost_allocations: [
        { id: "property-rent", source_type: "operational_expense", source_id: "expense-1", property_id: "property-1", location_id: null, amount: 1000, currency: "TZS", period_start: "2026-11-01", allocation_method: "direct" },
        { id: "outlet-maintenance", source_type: "operational_expense", source_id: "expense-2", property_id: "property-1", location_id: "outlet-1", amount: 200, currency: "TZS", period_start: "2026-11-01", allocation_method: "approved_rule" },
      ],
      restaurant_consumption_profiles: [{
        id: "profile-1", cost_class: "service_consumable", property_id: "property-1",
        location_id: null, effective_from: "2025-01-01", effective_to: null, active: true,
      }],
      restaurant_consumption_rules: [{
        id: "rule-1", profile_id: "profile-1", inventory_item_id: "napkin", quantity_per_cover: 1,
        effective_from: "2025-01-01", effective_to: null, active: true,
      }],
      restaurant_cost_reconciliation_runs: [{
        id: "recon-1", property_id: "property-1", status: "completed",
        period_start: "2026-11-01", period_end: "2026-11-30", currency: "TZS",
      }],
    });
    const result = await computeProfitability(sb, "user-1", { ...input, propertyId: "property-1" });
    const pos = result.dimensions.find((d: any) => d.dimension_type === "channel" && d.dimension_name === "pos");
    const delivery = result.dimensions.find((d: any) => d.dimension_type === "channel" && d.dimension_name === "delivery");
    const outlet1 = result.dimensions.find((d: any) => d.dimension_type === "outlet" && d.location_id === "outlet-1");
    const outlet2 = result.dimensions.find((d: any) => d.dimension_type === "outlet" && d.location_id === "outlet-2");
    const property = result.dimensions.find((d: any) => d.dimension_type === "property");
    expect(pos).toBeDefined();
    expect(delivery).toBeDefined();
    expect(outlet1).toBeDefined();
    expect(outlet2).toBeDefined();
    expect(property).toBeDefined();
    expect(pos!).toMatchObject({ allocated_operating_expenses: 1000, allocation_method: "sales_proportional", confidence_state: "estimated" });
    expect(delivery!).toMatchObject({ allocated_operating_expenses: 200, allocation_method: "sales_proportional", confidence_state: "estimated" });
    expect(outlet1!).toMatchObject({ allocated_operating_expenses: 1000, allocation_method: "mixed", confidence_state: "estimated" });
    expect(outlet2!).toMatchObject({ allocated_operating_expenses: 200, allocation_method: "sales_proportional", confidence_state: "estimated" });
    expect(property!).toMatchObject({ allocated_operating_expenses: 1200, allocation_method: "mixed", confidence_state: "fully_reconciled" });
    expect(pos!.allocated_operating_expenses + delivery!.allocated_operating_expenses).toBe(1200);
    expect(outlet1!.allocated_operating_expenses + outlet2!.allocated_operating_expenses).toBe(1200);
  });

  it("prorates monthly allocations to partial reporting periods", async () => {
    const sb = makeSupabase({
      restaurant_orders: [],
      restaurant_cost_allocations: [{
        amount: 3100, currency: "TZS", property_id: "property-1",
        location_id: null, period_start: "2026-11-01",
      }],
    });
    const result = await computeProfitability(sb, "user-1", {
      ...input,
      from: "2026-11-16T00:00:00.000Z",
      to: "2026-11-30T23:59:59.999Z",
    });
    expect(result.operational.allocatedOperatingExpenses).toBe(1550);
    expect(result.operational.operatingProfit).toBe(-1550);
  });

  it("rejects a sales source with no currency even when operating costs have one", async () => {
    const sb = makeSupabase({
      restaurant_orders: [{ id: "order-1", currency: null }],
      restaurant_cost_allocations: [{ amount: 100, currency: "TZS", property_id: "property-1", period_start: "2026-11-01" }],
    });
    await expect(computeProfitability(sb, "user-1", input)).rejects.toThrow(
      "Sales source currency is missing or invalid.",
    );
  });

  it("does not invent a reporting currency when the tenant has no currency-bearing sources", async () => {
    const sb = makeSupabase({
      restaurant_orders: [],
      restaurant_cost_allocations: [],
      restaurant_properties: [],
    });
    await expect(computeProfitability(sb, "user-1", input)).rejects.toThrow(
      "A single valid property reporting currency is required for this profitability report.",
    );
  });

  it("rejects mixed currencies between sales and allocated operating costs", async () => {
    const sb = makeSupabase({
      restaurant_orders: [{ id: "order-1", currency: "TZS" }],
      restaurant_cost_allocations: [{ amount: 100, currency: "USD", property_id: "property-1", period_start: "2026-11-01" }],
      restaurant_order_items: [],
      restaurant_stock_movements: [],
    });
    await expect(computeProfitability(sb, "user-1", input)).rejects.toThrow(
      "Profitability cannot combine sales and operating costs across currencies.",
    );
  });
});
