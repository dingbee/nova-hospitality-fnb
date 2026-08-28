/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
/**
 * O6 — matchInventoryItems wires the reusable catalog matching engine
 * (catalog/matching.ts) up to the real inventory table, tenant-scoped.
 */
import { describe, expect, it } from "vitest";
import { matchInventoryItems } from "./inventory.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

function makeFakeSupabase(items: any[]) {
  function builder(table: string) {
    const api: any = {
      select: () => api,
      eq: () => api,
      then: (resolve: any) => {
        if (table === "restaurant_members") {
          return resolve({
            data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
            error: null,
          });
        }
        return resolve({ data: table === "restaurant_inventory_items" ? items : [], error: null });
      },
    };
    return api;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string) =>
      fn === "has_any_role" ? { data: false, error: null } : { data: null, error: null },
  };
}

describe("matchInventoryItems", () => {
  it("finds an existing item by exact barcode instead of returning nothing", async () => {
    const sb = makeFakeSupabase([
      { id: "item-1", sku: "ITM-1", name: "Coca-Cola 500ml Bottle", barcode: "5449000000996" },
      { id: "item-2", sku: "ITM-2", name: "Sprite 500ml Bottle", barcode: "5449000133328" },
    ]);

    const result = await matchInventoryItems(sb as any, USER, {
      tenantId: TENANT,
      query: { barcode: "5449000000996" },
    });

    expect(result[0]!.candidate.id).toBe("item-1");
    expect(result[0]!.confidence).toBe("exact");
    expect(result[0]!.item.name).toBe("Coca-Cola 500ml Bottle");
  });

  it("returns nothing above the floor for an unknown barcode — never a false match", async () => {
    const sb = makeFakeSupabase([{ id: "item-1", sku: "ITM-1", name: "Tomato", barcode: "111" }]);
    const result = await matchInventoryItems(sb as any, USER, {
      tenantId: TENANT,
      query: { barcode: "999999999", name: undefined },
    });
    expect(result.every((r) => r.score === 0)).toBe(true);
  });
});
