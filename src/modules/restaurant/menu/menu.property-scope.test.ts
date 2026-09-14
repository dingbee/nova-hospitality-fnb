/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — configuration governance.
 *
 * upsertMenu/upsertMenuItem called `assertCapability(sb, userId, tenantId,
 * "menu.manage")` with NO property scope, despite restaurant_menus having a
 * real property_id/location_id the caller controls directly — the exact
 * escalation class already fixed for restaurant_members
 * (assertCanManageMembership). A property-scoped chef/restaurant_manager/GM
 * could create, edit, or publish a menu (or a menu item, via its parent
 * menu) belonging to a sibling property, and restaurant_menus/
 * restaurant_menu_items RLS was never migrated to a property-aware policy
 * (still using the tenant-only restaurant_can_write), so there was no
 * backstop either. Fix: pass `{ propertyId, locationId }` into
 * assertCapability, resolving it via the item's own menu for
 * upsertMenuItem (which has no property column of its own).
 */
import { describe, expect, it } from "vitest";
import { upsertMenu, upsertMenuItem } from "./menu.server";

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_CHEF_A1 = "chef-a1"; // chef scoped to Property A1 only
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide"; // owner, tenant-wide

function makeFakeSupabase() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_CHEF_A1, role: "chef", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_OWNER_TENANT_WIDE, role: "owner", property_id: null },
  ];
  const menus: any[] = [
    { id: "menu-a1", tenant_id: TENANT_A, property_id: PROPERTY_A1, location_id: null },
    { id: "menu-a2", tenant_id: TENANT_A, property_id: PROPERTY_A2, location_id: null },
  ];
  const menuItems: any[] = [];
  let seq = 0;

  function table(name: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;
    const filters: Array<(r: any) => boolean> = [];

    function rows(): any[] {
      if (name === "restaurant_members") return members;
      if (name === "restaurant_menus") return menus;
      if (name === "restaurant_menu_items") return menuItems;
      return [];
    }
    function matching() {
      return rows().filter((r) => filters.every((f) => f(r)));
    }

    const api: any = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      single: async () => {
        if (op === "insert") {
          seq += 1;
          const stored = { id: `${name}-new-${seq}`, ...payload };
          rows().push(stored);
          return { data: stored, error: null };
        }
        if (op === "update") {
          const target = matching()[0];
          if (!target) return { data: null, error: { message: "no matching row" } };
          Object.assign(target, payload);
          return { data: target, error: null };
        }
        return { data: matching()[0] ?? null, error: null };
      },
      then(resolve: any) {
        resolve({ data: matching(), error: null });
      },
    };
    return api;
  }

  return {
    rpc: async () => ({ data: false, error: null }),
    from: table,
    menus,
    menuItems,
  } as any;
}

describe("upsertMenu — property-scope escalation is blocked", () => {
  it("a chef scoped to Property A1 CAN create a menu at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertMenu(sb, USER_CHEF_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      name: "Lunch",
      slug: "lunch",
      version: 1,
      status: "draft",
      currency: "TZS",
    } as any);
    expect(created).toBeTruthy();
  });

  it("a chef scoped to Property A1 CANNOT create a menu at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertMenu(sb, USER_CHEF_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        name: "Lunch",
        slug: "lunch",
        version: 1,
        status: "draft",
        currency: "TZS",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a chef scoped to Property A1 CANNOT edit the existing menu-a2 (sibling property)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertMenu(sb, USER_CHEF_A1, {
        id: "menu-a2",
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        name: "Renamed",
        slug: "renamed",
        version: 1,
        status: "draft",
        currency: "TZS",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN create a menu at any property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertMenu(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A2,
      name: "Dinner",
      slug: "dinner",
      version: 1,
      status: "draft",
      currency: "TZS",
    } as any);
    expect(created).toBeTruthy();
  });
});

describe("upsertMenuItem — scope is inherited from the item's own menu, not left tenant-wide", () => {
  it("a chef scoped to Property A1 CAN add an item to menu-a1 (their own property's menu)", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertMenuItem(sb, USER_CHEF_A1, {
      tenantId: TENANT_A,
      menuId: "menu-a1",
      name: "Chips",
      slug: "chips",
      price: 5000,
      currency: "TZS",
    } as any);
    expect(created).toBeTruthy();
  });

  it("a chef scoped to Property A1 CANNOT add an item to menu-a2 (sibling property's menu) — the core escalation this closes", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertMenuItem(sb, USER_CHEF_A1, {
        tenantId: TENANT_A,
        menuId: "menu-a2",
        name: "Chips",
        slug: "chips",
        price: 5000,
        currency: "TZS",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN add an item to any property's menu", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertMenuItem(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      menuId: "menu-a2",
      name: "Steak",
      slug: "steak",
      price: 25000,
      currency: "TZS",
    } as any);
    expect(created).toBeTruthy();
  });
});
