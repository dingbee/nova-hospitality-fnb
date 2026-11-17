/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
import { describe, expect, it } from "vitest";
import {
  resolveTenantCurrency,
  verifyInventoryItem,
  verifyLocation,
  verifySupplier,
  verifyUnit,
} from "./resolve.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";

function makeFakeSupabase(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      maybeSingle: () => {
        const rows = rowsByTable[table] ?? [];
        const match = rows.find((r) => filters.every(([col, val]) => r[col] === val));
        return Promise.resolve({ data: match ?? null, error: null });
      },
    };
    return api;
  }
  return { from: (table: string) => builder(table) };
}

describe("verifyInventoryItem", () => {
  it("resolves an active item belonging to the caller's own tenant", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_items: [
        {
          id: "item-1",
          name: "Beef Fillet",
          unit_id: "unit-1",
          tenant_id: TENANT,
          status: "active",
        },
      ],
    });
    const row = await verifyInventoryItem(sb as any, TENANT, "item-1");
    expect(row).toEqual({ id: "item-1", name: "Beef Fillet", unitId: "unit-1" });
  });

  it("never resolves an id that belongs to a different tenant — a stale or spoofed id fails the fresh lookup", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_items: [
        {
          id: "item-1",
          name: "Beef Fillet",
          unit_id: null,
          tenant_id: OTHER_TENANT,
          status: "active",
        },
      ],
    });
    const row = await verifyInventoryItem(sb as any, TENANT, "item-1");
    expect(row).toBeNull();
  });

  it("never resolves an inactive item", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_items: [
        { id: "item-1", name: "Beef Fillet", unit_id: null, tenant_id: TENANT, status: "archived" },
      ],
    });
    const row = await verifyInventoryItem(sb as any, TENANT, "item-1");
    expect(row).toBeNull();
  });
});

describe("verifyLocation", () => {
  it("resolves an active location for the caller's tenant, including its location_type", async () => {
    const sb = makeFakeSupabase({
      restaurant_locations: [
        {
          id: "loc-1",
          name: "Kitchen",
          location_type: "kitchen",
          tenant_id: TENANT,
          status: "active",
        },
      ],
    });
    const row = await verifyLocation(sb as any, TENANT, "loc-1");
    expect(row).toEqual({ id: "loc-1", name: "Kitchen", locationType: "kitchen" });
  });

  it("rejects a cross-tenant location id", async () => {
    const sb = makeFakeSupabase({
      restaurant_locations: [
        {
          id: "loc-1",
          name: "Kitchen",
          location_type: "kitchen",
          tenant_id: OTHER_TENANT,
          status: "active",
        },
      ],
    });
    expect(await verifyLocation(sb as any, TENANT, "loc-1")).toBeNull();
  });
});

describe("verifySupplier", () => {
  it("resolves an active supplier for the caller's tenant", async () => {
    const sb = makeFakeSupabase({
      restaurant_suppliers: [
        { id: "sup-1", name: "Metro Wholesale", tenant_id: TENANT, status: "active" },
      ],
    });
    expect(await verifySupplier(sb as any, TENANT, "sup-1")).toEqual({
      id: "sup-1",
      name: "Metro Wholesale",
    });
  });

  it("rejects a cross-tenant supplier id", async () => {
    const sb = makeFakeSupabase({
      restaurant_suppliers: [
        { id: "sup-1", name: "Metro Wholesale", tenant_id: OTHER_TENANT, status: "active" },
      ],
    });
    expect(await verifySupplier(sb as any, TENANT, "sup-1")).toBeNull();
  });
});

describe("verifyUnit", () => {
  it("resolves a unit for the caller's tenant", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_units: [{ id: "unit-1", code: "kg", tenant_id: TENANT }],
    });
    expect(await verifyUnit(sb as any, TENANT, "unit-1")).toEqual({ id: "unit-1", code: "kg" });
  });

  it("rejects a cross-tenant unit id", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_units: [{ id: "unit-1", code: "kg", tenant_id: OTHER_TENANT }],
    });
    expect(await verifyUnit(sb as any, TENANT, "unit-1")).toBeNull();
  });
});

describe("resolveTenantCurrency", () => {
  it("reads the tenant's own configured currency rather than a hardcoded literal", async () => {
    const sb = makeFakeSupabase({
      restaurant_tenants: [{ id: TENANT, settings: { business: { defaultCurrency: "USD" } } }],
    });
    expect(await resolveTenantCurrency(sb as any, TENANT)).toBe("USD");
  });

  it("falls back to TZS only when the tenant has no configured currency", async () => {
    const sb = makeFakeSupabase({ restaurant_tenants: [{ id: TENANT, settings: {} }] });
    expect(await resolveTenantCurrency(sb as any, TENANT)).toBe("TZS");
  });

  it("falls back to TZS when the tenant row itself can't be found", async () => {
    const sb = makeFakeSupabase({ restaurant_tenants: [] });
    expect(await resolveTenantCurrency(sb as any, TENANT)).toBe("TZS");
  });
});
