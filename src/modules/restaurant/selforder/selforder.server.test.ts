/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { pickGuestOrderableLines, resolveGuestTableContext } from "./selforder.server";
import type { GuestLineInput } from "./selforder.contracts";

function line(overrides: Partial<GuestLineInput> = {}): GuestLineInput {
  return {
    menuItemId: "item-1",
    description: "Item",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    modifiers: [],
    ...overrides,
  };
}

describe("pickGuestOrderableLines", () => {
  it("accepts a line whose menuItemId is in the tenant's sellable set", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [line()]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects a menuItemId belonging to a different tenant's catalogue", () => {
    // Simulates a client sending a real, existing menu_item_id — just not one
    // that belongs to the tenant resolved from this table.
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-from-tenant-a"]), [
      line({ menuItemId: "item-from-tenant-b" }),
    ]);
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("rejects an open item with no menuItemId — no guest-priced free lines", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [
      line({ menuItemId: undefined, unitPrice: 999 }),
    ]);
    expect(valid).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("partitions a mixed batch instead of failing everything on one bad line", () => {
    const { valid, rejected } = pickGuestOrderableLines(new Set(["item-1"]), [
      line({ menuItemId: "item-1" }),
      line({ menuItemId: "unknown-item" }),
    ]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

/** Minimal fake matching only the `.from().select().eq().maybeSingle()` chain resolveGuestTableContext uses. */
function fakeSb(rows: Record<string, any[]>) {
  return {
    from(table: string) {
      let filtered = rows[table] ?? [];
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null }),
        then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
      };
      return builder;
    },
  };
}

describe("resolveGuestTableContext", () => {
  const baseRows = {
    restaurant_tables: [
      {
        id: "table-1",
        code: "T1",
        name: "Table 1",
        tenant_id: "tenant-1",
        property_id: "prop-1",
        location_id: "loc-1",
        active: true,
      },
      {
        id: "table-inactive",
        code: "T2",
        name: "Table 2",
        tenant_id: "tenant-1",
        property_id: "prop-1",
        location_id: "loc-1",
        active: false,
      },
    ],
    restaurant_tenants: [{ id: "tenant-1", name: "Demo Tenant", status: "active" }],
    restaurant_currencies: [],
  };

  it("resolves an active table to its tenant/property/location", async () => {
    const ctx = await resolveGuestTableContext(fakeSb(baseRows) as any, "table-1");
    expect(ctx).toMatchObject({
      tableId: "table-1",
      tenantId: "tenant-1",
      propertyId: "prop-1",
      locationId: "loc-1",
    });
  });

  it("refuses an inactive table", async () => {
    await expect(
      resolveGuestTableContext(fakeSb(baseRows) as any, "table-inactive"),
    ).rejects.toThrow(/not available/);
  });

  it("refuses a table id that does not exist — a guess is indistinguishable from an inactive table", async () => {
    await expect(
      resolveGuestTableContext(fakeSb(baseRows) as any, "no-such-table"),
    ).rejects.toThrow(/not available/);
  });

  it("refuses a table whose tenant is no longer active", async () => {
    const rows = {
      ...baseRows,
      restaurant_tenants: [{ id: "tenant-1", name: "Demo Tenant", status: "suspended" }],
    };
    await expect(resolveGuestTableContext(fakeSb(rows) as any, "table-1")).rejects.toThrow(
      /not available/,
    );
  });
});
