/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { askNova } from "./selfnova.server";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const TABLE = "table-1";
const OTHER_TABLE = "table-2";
const MENU = "menu-1";
const CATEGORY_MAINS = "cat-mains";
const ITEM_BURGER = "item-burger";
const ITEM_SALAD = "item-salad";
const PRODUCT_BURGER = "product-burger";
const VARIANT_DOUBLE = "variant-double";
const GROUP_SIDE = "group-side";

/**
 * A full fakeDb for the real fetchSellableCatalog()/guestMenu() chain —
 * table/tenant/currency resolution, the menu/category/item/product/
 * variant/modifier reads, and the pricing engine's loadRuleSet(). Ask NOVA
 * is deliberately tested end-to-end through the real catalogue path (not a
 * stubbed-out one) because "guest table scoping" and "cross-tenant
 * rejection" only mean something if the actual authorization boundary is
 * exercised, not bypassed.
 */
function fakeDb(rows: Record<string, any[]>) {
  function from(table: string) {
    let filtered = rows[table] ?? [];
    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return builder;
  }
  return { from };
}

function baseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
      {
        id: OTHER_TABLE,
        code: "T2",
        name: "T2",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
    ],
    restaurant_tenants: [
      { id: TENANT, name: "Demo", status: "active" },
      { id: OTHER_TENANT, name: "Other tenant", status: "active" },
    ],
    restaurant_currencies: [],
    restaurant_menus: [
      {
        id: MENU,
        name: "Main menu",
        status: "published",
        currency: "TZS",
        location_id: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_categories: [
      {
        id: CATEGORY_MAINS,
        name: "Mains",
        slug: "mains",
        kind: "menu",
        sort_order: 1,
        tenant_id: TENANT,
      },
    ],
    restaurant_menu_items: [
      {
        id: ITEM_BURGER,
        menu_id: MENU,
        category_id: CATEGORY_MAINS,
        name: "Beef Burger",
        description: "Grilled beef patty, cheddar, lettuce",
        price: 12000,
        currency: "TZS",
        available: true,
        tags: [],
        allergens: ["gluten", "dairy"],
        sort_order: 1,
        image_url: null,
        tenant_id: TENANT,
      },
      {
        id: ITEM_SALAD,
        menu_id: MENU,
        category_id: CATEGORY_MAINS,
        name: "Garden Salad",
        description: "Seasonal greens, vinaigrette",
        price: 8000,
        currency: "TZS",
        available: true,
        tags: ["vegetarian"],
        allergens: [],
        sort_order: 2,
        image_url: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_products: [
      {
        id: PRODUCT_BURGER,
        name: "Beef Burger",
        menu_item_id: ITEM_BURGER,
        station_id: null,
        price: null,
        product_type: "menu_item",
        active: true,
        tenant_id: TENANT,
      },
    ],
    restaurant_product_variants: [
      {
        id: VARIANT_DOUBLE,
        product_id: PRODUCT_BURGER,
        name: "Double patty",
        price: 3000,
        price_is_delta: true,
        active: true,
        sort_order: 1,
        tenant_id: TENANT,
      },
    ],
    restaurant_modifier_groups: [
      {
        id: GROUP_SIDE,
        code: "side",
        name: "Choice of side",
        min_select: 1,
        max_select: 1,
        required: true,
        sort_order: 1,
        active: true,
        tenant_id: TENANT,
      },
    ],
    restaurant_modifiers: [],
    restaurant_product_modifier_groups: [
      { product_id: PRODUCT_BURGER, group_id: GROUP_SIDE, sort_order: 1, tenant_id: TENANT },
    ],
    restaurant_stations: [],
    restaurant_prices: [
      {
        id: "price-burger",
        scope: "tenant",
        amount: 12000,
        currency: "TZS",
        tax_inclusive: false,
        version: 1,
        status: "active",
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_to: null,
        property_id: null,
        location_id: null,
        product_id: null,
        variant_id: null,
        menu_item_id: ITEM_BURGER,
        price_list_id: null,
        channel: null,
        tenant_id: TENANT,
      },
      {
        id: "price-salad",
        scope: "tenant",
        amount: 8000,
        currency: "TZS",
        tax_inclusive: false,
        version: 1,
        status: "active",
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_to: null,
        property_id: null,
        location_id: null,
        product_id: null,
        variant_id: null,
        menu_item_id: ITEM_SALAD,
        price_list_id: null,
        channel: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_promotions: [],
    restaurant_tax_rules: [],
    restaurant_service_charges: [],
    restaurant_price_lists: [],
    restaurant_rounding_rules: [],
    ...overrides,
  };
}

/** A scripted fake AI transport — no network call, matching the injectable shape askNova() accepts. */
function scriptedAi(content: string) {
  return async () => ({ content });
}
function failingAi(message = "AI advisory is not configured for this deployment.") {
  return async () => {
    throw new Error(message);
  };
}

describe("askNova", () => {
  it("recommends a real catalogue item when the model names it correctly", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "The Beef Burger is filling and pairs well with fries.",
        recommendedItemIds: [ITEM_BURGER],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Something filling" }, ai);
    expect(result).toEqual({
      ok: true,
      reply: "The Beef Burger is filling and pairs well with fries.",
      recommendedItems: [
        {
          id: ITEM_BURGER,
          name: "Beef Burger",
          price: 12000,
          currency: "TZS",
          categoryId: CATEGORY_MAINS,
        },
      ],
    });
  });

  it("discards a recommended item id that isn't in the actual sellable catalogue (an invented dish)", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Try our chef's special truffle risotto!",
        recommendedItemIds: ["invented-item-not-on-menu"],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Surprise me" }, ai);
    expect(result).toEqual({
      ok: true,
      reply: "Try our chef's special truffle risotto!",
      recommendedItems: [],
    });
  });

  it("never fabricates a price — the recommended item's price always comes from the catalogue, never the model", async () => {
    const sb = fakeDb(baseRows());
    // The model's own JSON has no price field at all (it isn't even asked
    // for one) — this proves the returned price is re-hydrated from the
    // catalogue, not merely "the model didn't happen to lie this time".
    const ai = scriptedAi(JSON.stringify({ reply: "Sure!", recommendedItemIds: [ITEM_SALAD] }));
    const result = await askNova(sb as any, { tableId: TABLE, message: "Something light" }, ai);
    expect(result).toMatchObject({ ok: true });
    expect((result as any).recommendedItems[0]).toEqual({
      id: ITEM_SALAD,
      name: "Garden Salad",
      price: 8000,
      currency: "TZS",
      categoryId: CATEGORY_MAINS,
    });
  });

  it("never claims availability the catalogue doesn't have — an unavailable menu item is never sent to the model at all", async () => {
    const rows = baseRows();
    rows.restaurant_menu_items = rows.restaurant_menu_items.map((i) =>
      i.id === ITEM_BURGER ? { ...i, available: false } : i,
    );
    const sb = fakeDb(rows);
    let sentSystemPrompt = "";
    const ai = async (opts: { system: string }) => {
      sentSystemPrompt = opts.system;
      return { content: JSON.stringify({ reply: "Sure!", recommendedItemIds: [] }) };
    };
    await askNova(sb as any, { tableId: TABLE, message: "Anything filling?" }, ai);
    expect(sentSystemPrompt).not.toContain("Beef Burger");
    expect(sentSystemPrompt).toContain("Garden Salad");
  });

  it("falls back gracefully (never a technical error, never a fabricated reply) when the AI gateway throws", async () => {
    const sb = fakeDb(baseRows());
    const result = await askNova(
      sb as any,
      { tableId: TABLE, message: "What should I get?" },
      failingAi(),
    );
    expect(result).toEqual({
      ok: false,
      reason: "ai_unavailable",
      categories: [{ id: CATEGORY_MAINS, name: "Mains" }],
    });
  });

  it("falls back gracefully when the model's response is malformed JSON", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi("not valid json at all, just narration");
    const result = await askNova(sb as any, { tableId: TABLE, message: "Hi" }, ai);
    expect(result).toEqual({
      ok: false,
      reason: "ai_unavailable",
      categories: [{ id: CATEGORY_MAINS, name: "Mains" }],
    });
  });

  it("falls back gracefully when the model returns well-formed JSON with no usable reply (unsafe/empty response)", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(JSON.stringify({ recommendedItemIds: [ITEM_BURGER] }));
    const result = await askNova(sb as any, { tableId: TABLE, message: "Hi" }, ai);
    expect(result).toEqual({
      ok: false,
      reason: "ai_unavailable",
      categories: [{ id: CATEGORY_MAINS, name: "Mains" }],
    });
  });

  it("the wrong table cannot ask NOVA using this table's context", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(JSON.stringify({ reply: "hi", recommendedItemIds: [] }));
    // Ask NOVA is scoped purely by tableId — "the wrong table" here means an
    // id that does not resolve to an active table at all (the same
    // guarantee resolveGuestTableContext already gives every guest surface).
    await expect(
      askNova(sb as any, { tableId: "no-such-table", message: "hi" }, ai),
    ).rejects.toThrow(/not available/i);
  });

  it("a table belonging to a different tenant only ever sees that tenant's own catalogue", async () => {
    const rows = baseRows();
    rows.restaurant_tables = [
      ...rows.restaurant_tables,
      {
        id: "table-other-tenant",
        code: "TX",
        name: "TX",
        tenant_id: OTHER_TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
    ];
    const sb = fakeDb(rows);
    let sentSystemPrompt = "";
    const ai = async (opts: { system: string }) => {
      sentSystemPrompt = opts.system;
      return { content: JSON.stringify({ reply: "hi", recommendedItemIds: [] }) };
    };
    await askNova(sb as any, { tableId: "table-other-tenant", message: "hi" }, ai);
    // tenant-2 has no menu/items seeded at all — proving the catalogue sent
    // to the model was scoped to that table's own tenant, not tenant-1's.
    expect(sentSystemPrompt).not.toContain("Beef Burger");
    expect(sentSystemPrompt).not.toContain("Garden Salad");
  });

  it("a suspended tenant's table is refused, exactly like every other guest surface", async () => {
    const rows = baseRows();
    rows.restaurant_tenants = rows.restaurant_tenants.map((t) =>
      t.id === TENANT ? { ...t, status: "suspended" } : t,
    );
    const sb = fakeDb(rows);
    const ai = scriptedAi(JSON.stringify({ reply: "hi", recommendedItemIds: [] }));
    await expect(askNova(sb as any, { tableId: TABLE, message: "hi" }, ai)).rejects.toThrow(
      /not available/i,
    );
  });

  it("no internal data (product ids, station ids, price rule ids, raw db shape) leaks into the result", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({ reply: "Great choice!", recommendedItemIds: [ITEM_BURGER] }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "hi" }, ai);
    expect(result).toMatchObject({ ok: true });
    const item = (result as any).recommendedItems[0];
    expect(Object.keys(item).sort()).toEqual(
      ["categoryId", "currency", "id", "name", "price"].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/product-burger|price-burger|station/i);
  });

  it("only tags/allergens actually present in the catalogue are ever sent to the model — nothing inferred", async () => {
    const sb = fakeDb(baseRows());
    let sentSystemPrompt = "";
    const ai = async (opts: { system: string }) => {
      sentSystemPrompt = opts.system;
      return { content: JSON.stringify({ reply: "hi", recommendedItemIds: [] }) };
    };
    await askNova(sb as any, { tableId: TABLE, message: "Any vegetarian options?" }, ai);
    const marker = "MENU JSON:\n";
    const parsed = JSON.parse(
      sentSystemPrompt.slice(sentSystemPrompt.indexOf(marker) + marker.length),
    );
    const salad = parsed.items.find((i: any) => i.id === ITEM_SALAD);
    const burger = parsed.items.find((i: any) => i.id === ITEM_BURGER);
    expect(salad.tags).toEqual(["vegetarian"]);
    expect(burger.allergens).toEqual(["gluten", "dairy"]);
    expect(burger.tags).toEqual([]);
  });
});
