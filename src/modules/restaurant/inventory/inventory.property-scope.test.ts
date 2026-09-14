/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — configuration governance, expanded coverage.
 *
 * `menu.property-scope.test.ts` proved the config-governance fix
 * (0061/0062_p09_*_property_scope.sql) for one representative table
 * (menus). This file proves the identical fix for inventory items:
 * upsertInventoryItem calls `assertCapability(sb, userId, tenantId,
 * "inventory.manage", { propertyId, locationId })` —
 * restaurant_inventory_items has real property_id/location_id columns
 * the caller controls directly. Does NOT mock "../core/access.server",
 * so the real property-scope logic actually runs.
 */
import { describe, expect, it, vi } from "vitest";
import { upsertInventoryItem } from "./inventory.server";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));
vi.mock("./movements.server", () => ({ insertMovement: vi.fn(async () => null) }));

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_RM_A1 = "rm-a1"; // restaurant_manager scoped to Property A1 — covers inventory.manage
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide";

function makeFakeSupabase() {
  const db: Record<string, any[]> = {
    restaurant_members: [
      { tenant_id: TENANT_A, user_id: USER_RM_A1, role: "restaurant_manager", property_id: PROPERTY_A1 },
      { tenant_id: TENANT_A, user_id: USER_OWNER_TENANT_WIDE, role: "owner", property_id: null },
    ],
    restaurant_inventory_items: [],
    restaurant_inventory_units: [],
  };
  let seq = 0;

  function builder(table: string) {
    db[table] = db[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    const inFilters: Record<string, any[]> = {};
    let mode: "select" | "insert" = "select";
    let payload: any = null;

    const api: any = {
      select: () => api,
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: any[]) {
        inFilters[col] = vals;
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      insert(row: any) {
        mode = "insert";
        payload = row;
        return api;
      },
      async single() {
        const r = run();
        const d = r[0];
        return d ? { data: d, error: null } : { data: null, error: { message: `${table}: not found` } };
      },
      then(resolve: any) {
        resolve({ data: run(), error: null });
      },
    };

    function run(): any[] {
      if (mode === "select") return db[table]!.filter((r) => filters.every((f) => f(r)));
      const row = { id: `${table}-new-${++seq}`, ...payload };
      db[table]!.push(row);
      return [row];
    }
    return api;
  }

  return { from: (t: string) => builder(t), rpc: async () => ({ data: false, error: null }) } as any;
}

describe("upsertInventoryItem — property-scope escalation is blocked", () => {
  it("a restaurant_manager scoped to Property A1 CAN create an inventory item at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertInventoryItem(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      name: "House Salt",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 500,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT create an inventory item at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertInventoryItem(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        name: "House Salt",
        itemType: "ingredient",
        currentQuantity: 0,
        averageCost: 500,
        currency: "TZS",
        trackBatches: false,
        allowNegative: false,
        packSize: 1,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN create an inventory item at any property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertInventoryItem(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A2,
      name: "House Pepper",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 500,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(created).toBeTruthy();
  });
});
