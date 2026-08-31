/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { askNova } from "./selfnova.server";

/**
 * Every other test in this file injects a scripted `ai` caller directly
 * into askNova's third parameter, which bypasses the module's own
 * `defaultAiCaller` — the real production wiring — entirely. That gap is
 * exactly how the corrective-pass regression (Guest Ask NOVA silently
 * calling ai-gateway.server.ts's Chat Completions default instead of the
 * Responses-API-only provider) went untested. This mock exists solely to
 * exercise the real default wiring in the "real transport wiring" describe
 * block below — it proves defaultAiCaller actually calls
 * callReasoningProvider("openai", ...), the same provider abstraction
 * Menu Intelligence already uses successfully.
 */
const callReasoningProviderMock = vi.fn();
vi.mock("@/lib/reasoning-provider.server", () => ({
  callReasoningProvider: (...args: unknown[]) => callReasoningProviderMock(...args),
}));

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
      operations: [],
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
      operations: [],
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

/**
 * GEP2 — conversational order preparation. These exercise askNova() end to
 * end (real guestMenu()/fetchSellableCatalog(), a scripted AI response)
 * proving the server, never the model, is authoritative over what actually
 * changes in the guest's basket.
 */
describe("askNova — proposed basket operations (GEP2)", () => {
  it("F/G: resolves a real 'add' operation the model proposed, e.g. after the guest says yes to a recommendation", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Certainly — I've added the Garden Salad. Would you like anything else?",
        recommendedItemIds: [],
        operations: [{ action: "add", itemId: ITEM_SALAD, quantity: 1 }],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Yes please" }, ai);
    expect(result).toMatchObject({ ok: true });
    expect((result as any).operations).toEqual([
      {
        status: "applied",
        action: "add",
        itemId: ITEM_SALAD,
        name: "Garden Salad",
        quantity: 1,
        modifierNames: [],
      },
    ]);
  });

  it("C: rejects (not_found) an operation referencing an item id the model invented — never guesses", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Done!",
        recommendedItemIds: [],
        operations: [{ action: "add", itemId: "invented-item-id" }],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Add the special" }, ai);
    expect((result as any).operations).toEqual([
      { status: "not_found", itemId: "invented-item-id" },
    ]);
  });

  it("L: a required modifier with no real modifiers defined is never silently fabricated — the guest is asked instead", async () => {
    // GROUP_SIDE is required on the burger but baseRows defines zero real
    // modifiers for it — proving there is no "default" this code could
    // silently invent to satisfy the requirement.
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Sure — the Beef Burger comes with a choice of side.",
        recommendedItemIds: [],
        operations: [{ action: "add", itemId: ITEM_BURGER }],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Add the burger" }, ai);
    expect((result as any).operations).toEqual([
      {
        status: "needs_modifier",
        itemId: ITEM_BURGER,
        name: "Beef Burger",
        groupName: "Choice of side",
        options: [],
      },
    ]);
  });

  it("G/H: resolves 'remove' only against an item genuinely present in the basket the guest actually has", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Done — I've removed the salad.",
        operations: [{ action: "remove", itemId: ITEM_SALAD }],
      }),
    );
    const withInBasket = await askNova(
      sb as any,
      {
        tableId: TABLE,
        message: "Remove the salad",
        basket: [{ menuItemId: ITEM_SALAD, quantity: 1 }],
      },
      ai,
    );
    expect((withInBasket as any).operations).toEqual([
      { status: "applied", action: "remove", itemId: ITEM_SALAD, name: "Garden Salad" },
    ]);

    const withoutInBasket = await askNova(
      sb as any,
      { tableId: TABLE, message: "Remove the salad", basket: [] },
      ai,
    );
    expect((withoutInBasket as any).operations).toEqual([
      { status: "not_in_basket", itemId: ITEM_SALAD, name: "Garden Salad" },
    ]);
  });

  it("I: resolves a real quantity change ('make that two') against the current basket", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Done — that's two Garden Salads.",
        operations: [{ action: "set_quantity", itemId: ITEM_SALAD, quantity: 2 }],
      }),
    );
    const result = await askNova(
      sb as any,
      {
        tableId: TABLE,
        message: "Make that two",
        basket: [{ menuItemId: ITEM_SALAD, quantity: 1 }],
      },
      ai,
    );
    expect((result as any).operations).toEqual([
      {
        status: "applied",
        action: "set_quantity",
        itemId: ITEM_SALAD,
        name: "Garden Salad",
        quantity: 2,
      },
    ]);
  });

  it("M: a stale recommendation for an item that has since become unavailable is never applied — it no longer resolves at all", async () => {
    // Item was available when NOVA recommended it earlier in the
    // conversation; by the time the guest confirms ("yes, prepare that"),
    // it has been marked unavailable. guestMenu() re-fetches fresh on
    // every call, so it is no longer part of this turn's real catalogue —
    // the operation safely fails closed (not_found) rather than adding a
    // now-stale item.
    const rows = baseRows();
    rows.restaurant_menu_items = rows.restaurant_menu_items.map((i) =>
      i.id === ITEM_SALAD ? { ...i, available: false } : i,
    );
    const sb = fakeDb(rows);
    const ai = scriptedAi(
      JSON.stringify({
        reply: "Certainly — I've prepared the Garden Salad.",
        operations: [{ action: "add", itemId: ITEM_SALAD }],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Yes, prepare that" }, ai);
    expect((result as any).operations).toEqual([{ status: "not_found", itemId: ITEM_SALAD }]);
  });

  it("K: a well-behaved model asks a clarifying question instead of guessing between two real items — nothing is applied", async () => {
    // The prompt instructs the model not to guess when a request could
    // match more than one real item; this proves the server-side contract
    // that holds regardless: an assistant reply with no operations changes
    // nothing in the basket, whatever the reply text says.
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({
        reply: "We have the Beef Burger and the Garden Salad — which would you like?",
        recommendedItemIds: [],
      }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Add the usual" }, ai);
    expect((result as any).operations).toEqual([]);
  });

  it("N: an applied 'add' operation never carries a price — the client re-derives it from the same real catalogue item, exactly like a manual add", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(
      JSON.stringify({ reply: "Sure!", operations: [{ action: "add", itemId: ITEM_SALAD }] }),
    );
    const result = await askNova(sb as any, { tableId: TABLE, message: "Add the salad" }, ai);
    const applied = (result as any).operations[0];
    expect(applied.status).toBe("applied");
    expect(Object.keys(applied).sort()).toEqual(
      ["status", "action", "itemId", "name", "quantity", "modifierNames"].sort(),
    );
  });

  it("O/P: operations are resolved purely against this table's own tenant catalogue and basket — no cross-tenant reference is possible", async () => {
    const sb = fakeDb(baseRows());
    // A basket line naming an item id that simply doesn't exist in this
    // tenant's own catalogue at all (standing in for "an id copied from a
    // different tenant/table") can never be resolved to a real add/remove.
    const ai = scriptedAi(
      JSON.stringify({
        reply: "hi",
        operations: [{ action: "remove", itemId: "item-from-another-tenant" }],
      }),
    );
    const result = await askNova(
      sb as any,
      {
        tableId: TABLE,
        message: "remove it",
        basket: [{ menuItemId: "item-from-another-tenant", quantity: 1 }],
      },
      ai,
    );
    expect((result as any).operations).toEqual([
      { status: "not_found", itemId: "item-from-another-tenant" },
    ]);
  });

  it("W: a malformed/absent operations field never throws and never applies anything", async () => {
    const sb = fakeDb(baseRows());
    const ai = scriptedAi(JSON.stringify({ reply: "hi", recommendedItemIds: [] }));
    const result = await askNova(sb as any, { tableId: TABLE, message: "hi" }, ai);
    expect((result as any).operations).toEqual([]);
  });
});

describe("askNova — real transport wiring (corrective pass regression)", () => {
  afterEach(() => {
    callReasoningProviderMock.mockReset();
  });

  it("with no aiCaller override (the real production call, exactly as staffnova/selfnova.functions.ts invoke it), Guest Ask NOVA routes through callReasoningProvider('openai', ...) — the same provider abstraction Menu Intelligence already uses, not a second, silently-incompatible ai-gateway.server.ts default", async () => {
    const sb = fakeDb(baseRows());
    callReasoningProviderMock.mockResolvedValue({
      content: JSON.stringify({ reply: "Sure, the burger is great!", recommendedItemIds: [] }),
      provider: "openai",
      unavailable: false,
    });

    const result = await askNova(sb as any, { tableId: TABLE, message: "What's good?" });

    expect(callReasoningProviderMock).toHaveBeenCalledTimes(1);
    expect(callReasoningProviderMock.mock.calls[0][0]).toBe("openai");
    expect((result as any).ok).toBe(true);
    expect((result as any).reply).toBe("Sure, the burger is great!");
  });

  it("when the provider reports unavailable, Guest Ask NOVA degrades to the honest ai_unavailable state — never a fabricated reply", async () => {
    const sb = fakeDb(baseRows());
    callReasoningProviderMock.mockResolvedValue({
      provider: "openai",
      unavailable: true,
      reason: "AI advisory is not configured for this deployment (missing NOVA_AI_API_KEY).",
    });

    const result = await askNova(sb as any, { tableId: TABLE, message: "What's good?" });

    expect((result as any).ok).toBe(false);
    expect((result as any).reason).toBe("ai_unavailable");
  });
});
