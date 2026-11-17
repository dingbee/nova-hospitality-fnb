/**
 * P08 — /api/v1/menus resource wrappers. There was previously no test
 * coverage for this file, and no object-level authorization check at all
 * on apiListMenuItems's menuId parameter (ME-12 finding, HIGH severity):
 * apiListMenus (the collection endpoint) correctly filters by the
 * credential's own property, but apiListMenuItems accepted a menuId
 * directly from the caller and queried items by (tenant_id, menu_id) only
 * — never checking that the referenced menu's OWN property matched the
 * credential's scope. A property-scoped credential could read another
 * property's menu items by ID substitution (classic IDOR, Phase 4D).
 * Fixed in resources/menus.ts by checking the menu's property before
 * calling into listMenuItems, mirroring the same pattern resources/
 * orders.ts already used for single-order reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import type { ResolvedCredential } from "../credentials.server";

const mocks = vi.hoisted(() => ({
  listMenus: vi.fn(),
  listMenuItems: vi.fn(),
}));

vi.mock("@/modules/restaurant/menu/menu.server", () => ({
  listMenus: mocks.listMenus,
  listMenuItems: mocks.listMenuItems,
}));

const { apiListMenuItems, apiListMenus } = await import("./menus");

function credential(overrides: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    id: "cred-1",
    tenantId: "tenant-a",
    propertyId: null,
    serviceUserId: "svc-1",
    scopes: ["menus:read"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apiListMenuItems — object-level authorization on menuId (IDOR fix)", () => {
  it("a property-scoped credential CANNOT read items of a menu belonging to a different property", async () => {
    const sb = createFakeSupabase({
      restaurant_menus: [{ id: "menu-B", tenant_id: "tenant-a", property_id: "property-B" }],
    });
    await expect(
      apiListMenuItems(sb, credential({ propertyId: "property-A" }), {
        menuId: "menu-B",
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(mocks.listMenuItems).not.toHaveBeenCalled();
  });

  it("the same property-scoped credential CAN read items of its own property's menu", async () => {
    const sb = createFakeSupabase({
      restaurant_menus: [{ id: "menu-A", tenant_id: "tenant-a", property_id: "property-A" }],
    });
    mocks.listMenuItems.mockResolvedValue([{ id: "item-1" }]);
    await expect(
      apiListMenuItems(sb, credential({ propertyId: "property-A" }), {
        menuId: "menu-A",
        limit: 50,
      }),
    ).resolves.toEqual([{ id: "item-1" }]);
  });

  it("a property-scoped credential CAN read a tenant-wide menu (property_id null)", async () => {
    const sb = createFakeSupabase({
      restaurant_menus: [{ id: "menu-wide", tenant_id: "tenant-a", property_id: null }],
    });
    mocks.listMenuItems.mockResolvedValue([]);
    await expect(
      apiListMenuItems(sb, credential({ propertyId: "property-A" }), {
        menuId: "menu-wide",
        limit: 50,
      }),
    ).resolves.toEqual([]);
  });

  it("a tenant-wide credential (propertyId null) can read any property's menu", async () => {
    const sb = createFakeSupabase({
      restaurant_menus: [{ id: "menu-B", tenant_id: "tenant-a", property_id: "property-B" }],
    });
    mocks.listMenuItems.mockResolvedValue([]);
    await expect(
      apiListMenuItems(sb, credential({ propertyId: null }), { menuId: "menu-B", limit: 50 }),
    ).resolves.toEqual([]);
  });

  it("a menuId from another tenant (or that doesn't exist) is a 404, not a leak of its existence or a 500", async () => {
    const sb = createFakeSupabase({
      restaurant_menus: [{ id: "menu-other-tenant", tenant_id: "tenant-B", property_id: null }],
    });
    await expect(
      apiListMenuItems(sb, credential({ tenantId: "tenant-a" }), {
        menuId: "menu-other-tenant",
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(mocks.listMenuItems).not.toHaveBeenCalled();
  });

  it("no menuId at all (list everything the credential can see) skips the per-menu check entirely", async () => {
    const sb = createFakeSupabase({ restaurant_menus: [] });
    mocks.listMenuItems.mockResolvedValue([{ id: "item-1" }]);
    await expect(
      apiListMenuItems(sb, credential({ propertyId: "property-A" }), { limit: 50 }),
    ).resolves.toEqual([{ id: "item-1" }]);
  });

  it("enforces menus:read scope before touching the database", async () => {
    const sb = createFakeSupabase({ restaurant_menus: [] });
    await expect(
      apiListMenuItems(sb, credential({ scopes: [] as never }), { limit: 50 }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("apiListMenus — collection endpoint stays property-filtered", () => {
  it("passes the credential's own property through to listMenus, never a client-supplied one", async () => {
    const sb = createFakeSupabase({});
    mocks.listMenus.mockResolvedValue([]);
    await apiListMenus(sb, credential({ propertyId: "property-A" }));
    expect(mocks.listMenus).toHaveBeenCalledWith(
      sb,
      "svc-1",
      expect.objectContaining({ tenantId: "tenant-a", propertyId: "property-A" }),
    );
  });
});
