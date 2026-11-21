/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fake Supabase rows. */
/**
 * WhatsApp Guest Portal (guest.$token) — ingredient-less menu items are hidden
 * from the guest menu and rejected on submission. Exercises the real
 * server-function bodies (guest-portal.server.ts) and the real guest-composition gate; only the
 * session resolver, catalogue and order writer are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "tenant-1";
const SESSION = {
  sessionId: "wa-session-1",
  scope: "guest_commerce",
  tenantId: T,
  propertyId: "prop-1",
  locationId: "loc-1",
  conversationId: "conv-1",
  currency: "TZS",
};

const rows: Record<string, any[]> = {};
function resetRows() {
  for (const key of Object.keys(rows)) delete rows[key];
  Object.assign(rows, {
    restaurant_tenants: [
      { id: T, name: "Nolmark CDMA Test Kitchen", status: "active", settings: {} },
    ],
    restaurant_locations: [
      {
        id: "loc-1",
        tenant_id: T,
        property_id: "prop-1",
        name: "Main Outlet",
        status: "active",
        location_type: "outlet",
        is_storage: false,
      },
    ],
    wa_conversations: [
      {
        id: "conv-1",
        tenant_id: T,
        property_id: "prop-1",
        location_id: "loc-1",
        guest_customer_id: null,
      },
    ],
    restaurant_products: [
      { tenant_id: T, menu_item_id: "item-fish", recipe_id: "r1", active: true },
    ],
    restaurant_recipes: [
      { tenant_id: T, id: "r1", lineage_id: "r1", version: 1, status: "active" },
    ],
    restaurant_recipe_lines: [
      {
        tenant_id: T,
        recipe_id: "r1",
        inventory_item_id: "inv-fish",
        sub_recipe_id: null,
        quantity: 0.3,
      },
    ],
    restaurant_recipe_components: [],
  });
}

const supabaseAdmin = {
  from(table: string) {
    let filtered = rows[table] ?? [];
    const builder: any = {
      select: () => builder,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const accepted = new Set(vals);
        filtered = filtered.filter((r) => accepted.has(r[col]));
        return builder;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      then: (resolve: (v: any) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return builder;
  },
  rpc: async () => ({ data: 0, error: null }),
};

const catalog = {
  categories: [],
  modifierGroups: [],
  items: [
    { id: "item-fish", name: "Grilled Fish", price: 18000, priceConfigured: true, available: true },
    { id: "item-empty", name: "Placeholder", price: 5000, priceConfigured: true, available: true },
  ],
};
const createGuestOrder = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin }));
vi.mock("@/modules/messaging/guest-portal-sessions.server", () => ({
  resolveWhatsAppGuestPortalSession: async () => SESSION,
}));
vi.mock("@/modules/restaurant/sales/pos.server", () => ({
  fetchSellableCatalog: async () => catalog,
}));
vi.mock("@/modules/restaurant/sales/sales.server", () => ({
  createGuestOrder: (...args: unknown[]) => createGuestOrder(...args),
}));
vi.mock("@/modules/restaurant/kitchen/kitchen.server", () => ({ fireGuestOrder: vi.fn() }));

const { guestPortalMenu, submitGuestCommerceOrder } = await import("./guest-portal.server");

const token = "a".repeat(43);
const line = (menuItemId: string) => ({
  menuItemId,
  description: menuItemId,
  quantity: 1,
  unitPrice: 0,
  discount: 0,
  modifiers: [],
});

beforeEach(() => {
  resetRows();
  createGuestOrder.mockReset();
  createGuestOrder.mockResolvedValue({
    id: "order-1",
    order_number: "ORD-1",
    total: 18000,
    status: "open",
    idempotent: false,
  });
});

describe("WhatsApp Guest Portal — ingredient-less items are guest-hidden", () => {
  it("menu lists only ingredient-backed items", async () => {
    const menu: any = await guestPortalMenu({ token });
    expect(menu.items.map((i: any) => i.id)).toEqual(["item-fish"]);
  });

  it("legacy direct composition also counts as configured", async () => {
    rows.restaurant_recipe_components = [
      { tenant_id: T, menu_item_id: "item-empty", inventory_item_id: "inv-x", quantity: 1 },
    ];
    const menu: any = await guestPortalMenu({ token });
    expect(menu.items.map((i: any) => i.id)).toEqual(["item-fish", "item-empty"]);
  });

  it("submission of a configured item reaches the authoritative order writer", async () => {
    await submitGuestCommerceOrder({
      token,
      clientRequestId: "req-12345678",
      lines: [line("item-fish")],
    });
    expect(createGuestOrder).toHaveBeenCalledTimes(1);
  });

  it("a crafted submission for an ingredient-less item is rejected before any order is written", async () => {
    await expect(
      submitGuestCommerceOrder({
        token,
        clientRequestId: "req-12345678",
        lines: [line("item-fish"), line("item-empty")],
      }),
    ).rejects.toThrow(/no longer available/);
    expect(createGuestOrder).not.toHaveBeenCalled();
  });
});
