/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createP05FakeSupabase,
  OWNER,
  OWNER_MEMBER,
  TENANT_A,
  TENANT_B,
} from "../../intelligence/p05.test-helpers";
import { resolveWindowDays } from "./datasets.intelligence.server";

const assertEntitledMock = vi.fn();
vi.mock("@/modules/commercial/resolver.server", () => ({
  assertEntitled: (...args: unknown[]) => assertEntitledMock(...args),
  CommercialEntitlementError: class CommercialEntitlementError extends Error {
    constructor(
      public capabilityCode: string,
      public state: string,
    ) {
      super(`Forbidden — "${capabilityCode}" is not entitled (state: ${state}).`);
    }
  },
}));

const { buildDataset } = await import("./datasets.server");

const VIEWER_MEMBER = { tenant_id: TENANT_A, user_id: OWNER, role: "viewer", property_id: null };

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function order(id: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    closed_at: iso(daysAgo),
    opened_at: iso(daysAgo),
    subtotal: 10000,
    discount_total: 0,
    tax_total: 0,
    service_charge: 0,
    total: 10000,
    paid_total: 10000,
    payment_state: "paid",
    currency: "TZS",
    status: "closed",
    service_period_id: null,
    ...extra,
  };
}

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
});

function baseTables(overrides: Record<string, unknown[]> = {}) {
  return {
    restaurant_members: [OWNER_MEMBER],
    restaurant_tenants: [{ id: TENANT_A, name: "Tenant A" }],
    restaurant_locations: [],
    restaurant_orders: [],
    restaurant_order_items: [],
    restaurant_service_periods: [],
    restaurant_menu_items: [],
    restaurant_recipe_costs: [],
    restaurant_inventory_items: [],
    restaurant_stock_movements: [],
    restaurant_supplier_products: [],
    restaurant_suppliers: [],
    restaurant_purchase_orders: [],
    restaurant_profitability_snapshots: [],
    ...overrides,
  };
}

describe("resolveWindowDays", () => {
  it("uses an explicit windowDays when given", () => {
    expect(
      resolveWindowDays({
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        windowDays: 45,
        limit: 10,
      } as any),
    ).toBe(45);
  });

  it("derives windowDays from the from/to date-range picker, clamped to [7, 120]", () => {
    expect(
      resolveWindowDays({
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        from: "2026-01-01",
        to: "2026-01-15",
        limit: 10,
      } as any),
    ).toBe(14);
    expect(
      resolveWindowDays({
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        from: "2026-01-01",
        to: "2026-01-02",
        limit: 10,
      } as any),
    ).toBe(7); // clamped up from 1
    expect(
      resolveWindowDays({
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        from: "2026-01-01",
        to: "2027-01-01",
        limit: 10,
      } as any),
    ).toBe(120); // clamped down from 365
  });

  it("falls back to 30 when neither windowDays nor a usable from/to is given", () => {
    expect(
      resolveWindowDays({ tenantId: TENANT_A, type: "revenue_intelligence", limit: 10 } as any),
    ).toBe(30);
  });
});

describe("intelligence dataset exports — authorization", () => {
  it("rejects a role without intelligence.read before any engine call", async () => {
    const sb = createP05FakeSupabase(baseTables({ restaurant_members: [VIEWER_MEMBER] }));
    await expect(
      buildDataset(sb, OWNER, {
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        limit: 10,
      } as any),
    ).rejects.toThrow(/intelligence\.read/);
  });
});

describe("revenue_intelligence export", () => {
  it("reconciles sales composition against the same engine the Pro Intelligence screen reads", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_orders: [
          order("o1", 1, {
            subtotal: 12000,
            discount_total: 1000,
            tax_total: 400,
            service_charge: 100,
            total: 11500,
            paid_total: 11500,
          }),
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "revenue_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    const composition = wb.sheets.find((s) => s.name === "Sales Composition")!;
    expect(composition.rows[0]).toMatchObject({
      grossSales: 12000,
      discountTotal: 1000,
      taxTotal: 400,
      serviceChargeTotal: 100,
      netSales: 11500,
      cashCollected: 11500,
      outstandingAmount: 0,
    });
    expect(wb.metadata.rowCount).toBeGreaterThan(0);
    expect(wb.fileStem).toContain("revenue-intelligence");
  });

  it("never mixes another tenant's orders into the exported series", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_orders: [order("a", 1), order("b", 1, { id: "b", tenant_id: TENANT_B })],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "revenue_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    const composition = wb.sheets.find((s) => s.name === "Sales Composition")!;
    expect(composition.rows[0]!.netSales).toBe(10000); // only tenant A's single order
  });

  it("rejects a caller whose property grant does not cover the requested property (delegated to revenue.server.ts's own check)", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-1",
    };
    const sb = createP05FakeSupabase(baseTables({ restaurant_members: [scopedMember] }));
    await expect(
      buildDataset(sb, OWNER, {
        tenantId: TENANT_A,
        type: "revenue_intelligence",
        propertyId: "prop-forged",
        limit: 10,
      } as any),
    ).rejects.toThrow(/do not have access to this property/);
  });

  it("handles an empty window without error", async () => {
    const sb = createP05FakeSupabase(baseTables());
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "revenue_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    const series = wb.sheets.find((s) => s.name === "Daily Series")!;
    expect(series.rows).toEqual([]);
    const composition = wb.sheets.find((s) => s.name === "Sales Composition")!;
    expect(composition.rows[0]).toMatchObject({
      netSales: 0,
      cashCollected: 0,
      outstandingAmount: 0,
    });
  });
});

describe("menu_intelligence export", () => {
  it("exports item-level sales/cost/margin/classification, excluding voided lines", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_orders: [order("o1", 1)],
        restaurant_order_items: [
          {
            order_id: "o1",
            tenant_id: TENANT_A,
            menu_item_id: "mi-1",
            description: "Burger",
            quantity: 2,
            line_total: 20000,
            line_cost: 8000,
            status: "served",
          },
          {
            order_id: "o1",
            tenant_id: TENANT_A,
            menu_item_id: "mi-1",
            description: "Burger",
            quantity: 99,
            line_total: 999999,
            line_cost: 1,
            status: "voided",
          },
        ],
        restaurant_menu_items: [
          {
            id: "mi-1",
            tenant_id: TENANT_A,
            name: "Burger",
            price: 10000,
            currency: "TZS",
            cost_price: 4000,
          },
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "menu_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    const sheet = wb.sheets.find((s) => s.name === "Menu Items")!;
    const burger = sheet.rows.find((r) => r.name === "Burger")!;
    expect(burger.quantitySold).toBe(2);
    expect(burger.revenue).toBe(20000);
  });

  it("no capability entitlement gate — menu_intelligence is ungated Core, only intelligence.read applies", async () => {
    const sb = createP05FakeSupabase(baseTables());
    await expect(
      buildDataset(sb, OWNER, {
        tenantId: TENANT_A,
        type: "menu_intelligence",
        windowDays: 30,
        limit: 10,
      } as any),
    ).resolves.toBeDefined();
    expect(assertEntitledMock).not.toHaveBeenCalled();
  });
});

describe("demand_intelligence export", () => {
  it("exports emerging/declining items and calls demand_intelligence entitlement", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_orders: [order("cur", 1), order("prev", 35)],
        restaurant_order_items: [
          {
            order_id: "cur",
            tenant_id: TENANT_A,
            menu_item_id: "hot",
            description: "Hot",
            quantity: 10,
            status: "served",
          },
          {
            order_id: "prev",
            tenant_id: TENANT_A,
            menu_item_id: "hot",
            description: "Hot",
            quantity: 4,
            status: "served",
          },
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "demand_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    expect(assertEntitledMock).toHaveBeenCalledWith(
      sb,
      TENANT_A,
      "demand_intelligence",
      expect.anything(),
    );
    const emerging = wb.sheets.find((s) => s.name === "Emerging Items")!;
    expect(emerging.rows.some((r) => r.name === "Hot")).toBe(true);
  });
});

describe("forecasting_intelligence export", () => {
  it("passes horizonDays through and exports forecast points plus inventory requirements", async () => {
    const sb = createP05FakeSupabase(baseTables());
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "forecasting_intelligence",
      windowDays: 30,
      horizonDays: 21,
      limit: 10,
    } as any);
    expect(wb.metadata.dateRange).toContain("21-day horizon");
    expect(wb.sheets.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "Sales Demand Forecast",
        "Revenue Forecast",
        "Inventory Requirement",
      ]),
    );
  });
});

describe("inventory_intelligence_pro export", () => {
  it("exports anomalies and reorder requirements from the Pro-gated engine", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_inventory_items: [
          {
            id: "i1",
            tenant_id: TENANT_A,
            property_id: null,
            location_id: null,
            name: "Flour",
            current_quantity: 1,
            reorder_point: 5,
            average_cost: 10,
            currency: "TZS",
            status: "active",
          },
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "inventory_intelligence_pro",
      windowDays: 30,
      limit: 10,
    } as any);
    expect(assertEntitledMock).toHaveBeenCalledWith(
      sb,
      TENANT_A,
      "inventory_intelligence",
      expect.anything(),
    );
    expect(wb.sheets.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Consumption Anomalies", "Reorder Requirements"]),
    );
  });
});

describe("advanced_analytics export", () => {
  it("flattens correlation evidence into a readable string column", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_orders: [order("o1", 1)],
        restaurant_order_items: [
          {
            order_id: "o1",
            tenant_id: TENANT_A,
            menu_item_id: "mi-1",
            description: "Burger",
            quantity: 50,
            line_total: 500000,
            line_cost: 480000,
            status: "served",
          },
        ],
        restaurant_menu_items: [
          {
            id: "mi-1",
            tenant_id: TENANT_A,
            name: "Burger",
            price: 10000,
            currency: "TZS",
            cost_price: 9600,
          },
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "advanced_analytics",
      windowDays: 30,
      limit: 10,
    } as any);
    const sheet = wb.sheets.find((s) => s.name === "Correlations")!;
    for (const row of sheet.rows) {
      expect(typeof row.evidence).toBe("string");
    }
  });
});

describe("executive_intelligence export", () => {
  it("exports a one-row health summary plus anomalies/recommendations sheets", async () => {
    const sb = createP05FakeSupabase(baseTables());
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "executive_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    const summary = wb.sheets.find((s) => s.name === "Health Summary")!;
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toHaveProperty("overallHealth");
    expect(wb.sheets.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "Health Summary",
        "Significant Anomalies",
        "Priority Recommendations",
      ]),
    );
  });
});

describe("multi_location_intelligence export", () => {
  it("exports per-location and per-property rollups, never a raw re-derivation", async () => {
    const sb = createP05FakeSupabase(
      baseTables({
        restaurant_locations: [
          { id: "loc-a", tenant_id: TENANT_A, name: "Outlet A", property_id: "prop-a" },
          { id: "loc-b", tenant_id: TENANT_A, name: "Outlet B", property_id: "prop-b" },
        ],
        restaurant_orders: [
          order("oa", 1, { location_id: "loc-a", property_id: "prop-a" }),
          order("ob", 1, { id: "ob", location_id: "loc-b", property_id: "prop-b" }),
        ],
      }),
    );
    const wb = await buildDataset(sb, OWNER, {
      tenantId: TENANT_A,
      type: "multi_location_intelligence",
      windowDays: 30,
      limit: 10,
    } as any);
    expect(assertEntitledMock).toHaveBeenCalledWith(
      sb,
      TENANT_A,
      "multi_location_command",
      expect.anything(),
    );
    const locations = wb.sheets.find((s) => s.name === "Locations")!;
    expect(locations.rows.map((r) => r.name).sort()).toEqual(["Outlet A", "Outlet B"]);
  });
});
