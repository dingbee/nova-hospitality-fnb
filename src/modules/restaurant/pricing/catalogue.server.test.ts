/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Pricing Centre operator workspace — pricingCatalogue().
 *
 * Covers: name-based item discovery (no UUID needed — spec section 15),
 * pricing-state derivation (active/no_price/pending_approval/scheduled),
 * cost/margin computed from the same recipe costing the order path uses,
 * and filter narrowing (status/category/search).
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "./__tests__/fakeSupabase";

vi.mock("../core/access.server", () => ({
  assertTenantRead: vi.fn(async () => true),
}));

const { pricingCatalogue } = await import("./catalogue.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const MENU = "33333333-3333-3333-3333-333333333333";
const CATEGORY = "44444444-4444-4444-4444-444444444444";
const ITEM_BURGER = "55555555-5555-5555-5555-555555555555";
const ITEM_TOAST = "66666666-6666-6666-6666-666666666666";
const RECIPE = "77777777-7777-7777-7777-777777777777";
const PRODUCT = "88888888-8888-8888-8888-888888888888";

function baseSeed(overrides: Record<string, any[]> = {}) {
  return {
    restaurant_menus: [
      {
        id: MENU,
        tenant_id: TENANT,
        name: "Main Menu",
        status: "published",
        property_id: null,
        location_id: null,
      },
    ],
    restaurant_menu_items: [
      {
        id: ITEM_BURGER,
        tenant_id: TENANT,
        name: "Classic Chicken Burger",
        menu_id: MENU,
        category_id: CATEGORY,
        price: 15000,
        currency: "TZS",
        available: true,
        archived_at: null,
      },
      {
        id: ITEM_TOAST,
        tenant_id: TENANT,
        name: "Avocado Toast",
        menu_id: MENU,
        category_id: null,
        price: null,
        currency: "TZS",
        available: true,
        archived_at: null,
      },
    ],
    restaurant_categories: [{ id: CATEGORY, tenant_id: TENANT, name: "Mains" }],
    restaurant_products: [],
    restaurant_recipes: [],
    restaurant_prices: [],
    restaurant_promotions: [],
    restaurant_tax_rules: [],
    restaurant_service_charges: [],
    restaurant_price_lists: [],
    restaurant_rounding_rules: [],
    ...overrides,
  };
}

const activePriceRow = (over: Record<string, any> = {}) => ({
  id: "price-active",
  tenant_id: TENANT,
  menu_item_id: ITEM_BURGER,
  scope: "tenant",
  amount: 18000,
  currency: "TZS",
  tax_inclusive: false,
  version: 1,
  status: "active",
  effective_from: "2026-01-01T00:00:00.000Z",
  effective_to: null,
  property_id: null,
  location_id: null,
  product_id: null,
  variant_id: null,
  price_list_id: null,
  channel: null,
  ...over,
});

describe("pricingCatalogue — item discovery", () => {
  it("finds an item purely by name, no UUID entry needed", async () => {
    const { sb } = makeFakeSupabase(baseSeed());
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      search: "chicken burger",
    } as any);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.name).toBe("Classic Chicken Burger");
  });

  it("returns nothing for a search that matches no item", async () => {
    const { sb } = makeFakeSupabase(baseSeed());
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      search: "pizza",
    } as any);
    expect(result.rows).toHaveLength(0);
  });

  it("narrows to a category", async () => {
    const { sb } = makeFakeSupabase(baseSeed());
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      categoryId: CATEGORY,
    } as any);
    expect(result.rows.map((r) => r.name)).toEqual(["Classic Chicken Burger"]);
  });
});

describe("pricingCatalogue — pricing state derivation", () => {
  it("is 'no_price' when nothing is configured", async () => {
    const { sb } = makeFakeSupabase(baseSeed());
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.state).toBe("no_price");
    expect(row.activePrice).toBeNull();
  });

  it("is 'active' when a tenant-scoped active price resolves for this channel", async () => {
    const { sb } = makeFakeSupabase(baseSeed({ restaurant_prices: [activePriceRow()] }));
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.state).toBe("active");
    expect(row.activePrice).toEqual(expect.objectContaining({ amount: 18000, currency: "TZS" }));
  });

  it("is 'pending_approval' when only a pending price matches this scope and no active price exists", async () => {
    const { sb } = makeFakeSupabase(
      baseSeed({
        restaurant_prices: [
          activePriceRow({
            id: "price-pending",
            status: "pending_approval",
          }),
        ],
      }),
    );
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.state).toBe("pending_approval");
    expect(row.pendingPrice).toEqual(expect.objectContaining({ amount: 18000, currency: "TZS" }));
  });

  it("is 'scheduled' when only a future-dated active price exists — never resolved as sellable yet", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { sb } = makeFakeSupabase(
      baseSeed({
        restaurant_prices: [activePriceRow({ id: "price-future", effective_from: future })],
      }),
    );
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.state).toBe("scheduled");
    expect(row.activePrice).toBeNull();
    expect(row.scheduledPrice).toEqual(expect.objectContaining({ amount: 18000, currency: "TZS" }));
  });

  it("a location-scoped price does not resolve under a different outlet filter", async () => {
    // The menu itself is assigned to Outlet B (so filtering by Outlet B still
    // surfaces the item); the price on it was configured for Outlet A only.
    const { sb } = makeFakeSupabase({
      ...baseSeed({ restaurant_prices: [activePriceRow({ location_id: "loc-a" })] }),
      restaurant_menus: [
        {
          id: MENU,
          tenant_id: TENANT,
          name: "Main Menu",
          status: "published",
          property_id: null,
          location_id: "loc-b",
        },
      ],
    });
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      locationId: "loc-b",
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.state).toBe("no_price");
  });

  it("status filter narrows the returned rows to that pricing state", async () => {
    const { sb } = makeFakeSupabase(baseSeed({ restaurant_prices: [activePriceRow()] }));
    const activeOnly = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      status: "active",
    } as any);
    expect(activeOnly.rows.map((r) => r.menuItemId)).toEqual([ITEM_BURGER]);

    const noPriceOnly = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
      status: "no_price",
    } as any);
    expect(noPriceOnly.rows.map((r) => r.menuItemId)).toEqual([ITEM_TOAST]);
  });
});

describe("pricingCatalogue — cost and margin", () => {
  it("computes margin/food-cost from the item's active recipe cost, when one exists", async () => {
    const { sb } = makeFakeSupabase(
      baseSeed({
        restaurant_prices: [activePriceRow()],
        restaurant_products: [
          {
            id: PRODUCT,
            tenant_id: TENANT,
            menu_item_id: ITEM_BURGER,
            recipe_id: RECIPE,
            active: true,
          },
        ],
        restaurant_recipes: [
          {
            id: RECIPE,
            tenant_id: TENANT,
            lineage_id: null,
            version: 1,
            status: "active",
            computed_cost: 4591,
          },
        ],
      }),
    );
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.recipeCost).toBe(4591);
    expect(row.marginPercent).toBeCloseTo(74.5, 1);
    expect(row.foodCostPercent).toBeCloseTo(25.5, 1);
  });

  it("leaves cost/margin unavailable rather than fabricated when there is no recipe", async () => {
    const { sb } = makeFakeSupabase(baseSeed({ restaurant_prices: [activePriceRow()] }));
    const result = await pricingCatalogue(sb, USER, {
      tenantId: TENANT,
      channel: "dine_in",
      limit: 300,
    } as any);
    const row = result.rows.find((r) => r.menuItemId === ITEM_BURGER)!;
    expect(row.recipeCost).toBeNull();
    expect(row.marginPercent).toBeNull();
  });
});
