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
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        insert: (rows: unknown[]) => {
          persisted?.push(rows);
          return Promise.resolve({ error: null });
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: data[table] ?? [], error: null }).then(resolve, reject),
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
      restaurant_cost_allocations: [{ amount: 125000, currency: "TZS" }],
    });
    const result = await computeProfitability(sb, "user-1", input);
    expect(result.rows).toEqual([]);
    expect(result.totals).toMatchObject({
      revenue: 0,
      allocated_operating_expenses: 125000,
      contribution_profit: -125000,
      contribution_margin_percent: null,
      currency: "TZS",
    });
  });

  it("calculates contribution profit from all rows, not only the displayed page, and persists the full snapshot", async () => {
    const persisted: unknown[][] = [];
    const sb = makeSupabase({
      restaurant_orders: [{ id: "order-1", currency: "TZS" }],
      restaurant_cost_allocations: [{ amount: 10000, currency: "TZS" }],
      restaurant_order_items: [
        { id: "line-1", menu_item_id: "menu-1", description: "Pilau", quantity: 2, line_total: 30000, line_cost: 10000, status: "served" },
        { id: "line-2", menu_item_id: "menu-2", description: "Juice", quantity: 1, line_total: 10000, line_cost: 3000, status: "served" },
      ],
      restaurant_stock_movements: [
        { order_item_id: "line-1", total_cost: 12000 },
        { order_item_id: "line-2", total_cost: 4000 },
      ],
    }, persisted);
    const result = await computeProfitability(sb, "user-1", { ...input, persist: true, limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.totals).toMatchObject({
      quantity_sold: 3,
      revenue: 40000,
      theoretical_cost: 13000,
      actual_cost: 16000,
      variance: 3000,
      gross_profit: 24000,
      allocated_operating_expenses: 10000,
      contribution_profit: 14000,
      contribution_margin_percent: 35,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(2);
  });

  it("rejects mixed currencies between sales and allocated operating costs", async () => {
    const sb = makeSupabase({
      restaurant_orders: [{ id: "order-1", currency: "TZS" }],
      restaurant_cost_allocations: [{ amount: 100, currency: "USD" }],
      restaurant_order_items: [],
      restaurant_stock_movements: [],
    });
    await expect(computeProfitability(sb, "user-1", input)).rejects.toThrow(
      "Profitability cannot combine sales and operating costs across currencies.",
    );
  });
});
