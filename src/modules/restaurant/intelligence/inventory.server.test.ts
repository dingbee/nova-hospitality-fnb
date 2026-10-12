import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({ assertTenantRead: vi.fn() }));

import { getInventoryIntelligence } from "./inventory.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function fakeSupabase(failedTable: string) {
  const responses: Record<string, unknown> = {
    restaurant_inventory_items: { data: [], error: null },
    restaurant_stock_movements: { data: [], error: null },
    restaurant_supplier_products: { data: [], error: null },
    restaurant_suppliers: { data: [], error: null },
  };
  responses[failedTable] = { data: null, error: { message: "simulated read failure" } };
  return {
    from(table: string) {
      const query: any = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(responses[table]).then(resolve, reject),
      };
      return query;
    },
  } as any;
}

describe("getInventoryIntelligence — read integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "restaurant_inventory_items",
    "restaurant_stock_movements",
    "restaurant_supplier_products",
    "restaurant_suppliers",
  ])("fails closed when %s cannot be read", async (table) => {
    const sb = fakeSupabase(table);

    await expect(
      getInventoryIntelligence(sb, USER, { tenantId: TENANT, windowDays: 30 }),
    ).rejects.toThrow(/Inventory intelligence could not load .*simulated read failure/i);
  });
});
