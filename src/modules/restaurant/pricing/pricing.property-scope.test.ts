/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — configuration governance, expanded coverage.
 *
 * `menu.property-scope.test.ts` proved the config-governance fix
 * (0061_p09_config_governance_property_scope.sql) for one representative
 * table (menus). This file proves the identical fix for pricing:
 * upsertPrice/upsertTaxRule/upsertServiceCharge/upsertDiscountRule all
 * call `assertCapability(sb, userId, tenantId, "<capability>", {
 * propertyId, locationId })` — each of these tables has a real
 * property_id column the caller controls directly. Does NOT mock
 * "../core/access.server", so the real property-scope logic actually
 * runs.
 */
import { describe, expect, it, vi } from "vitest";
import { upsertDiscountRule, upsertPrice, upsertServiceCharge, upsertTaxRule } from "./pricing.server";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_RM_A1 = "rm-a1"; // restaurant_manager scoped to Property A1 — covers pricing.manage/discount.manage
const USER_GM_A1 = "gm-a1"; // general_manager scoped to Property A1 — covers tax.manage (restaurant_manager does not)
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide";

function makeFakeSupabase() {
  const db: Record<string, any[]> = {
    restaurant_members: [
      { tenant_id: TENANT_A, user_id: USER_RM_A1, role: "restaurant_manager", property_id: PROPERTY_A1 },
      { tenant_id: TENANT_A, user_id: USER_GM_A1, role: "general_manager", property_id: PROPERTY_A1 },
      { tenant_id: TENANT_A, user_id: USER_OWNER_TENANT_WIDE, role: "owner", property_id: null },
    ],
  };
  let seq = 0;

  function builder(table: string) {
    db[table] = db[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: any = null;

    const api: any = {
      select: () => api,
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return api;
      },
      order: () => api,
      limit: () => api,
      insert(row: any) {
        mode = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        mode = "update";
        payload = patch;
        return api;
      },
      async single() {
        const r = run();
        const d = r[0];
        return d ? { data: d, error: null } : { data: null, error: { message: `${table}: not found` } };
      },
      async maybeSingle() {
        const r = run();
        return { data: r[0] ?? null, error: null };
      },
      then(resolve: any) {
        resolve({ data: run(), error: null });
      },
    };

    function run(): any[] {
      if (mode === "select") return db[table]!.filter((r) => filters.every((f) => f(r)));
      if (mode === "insert") {
        const row = { id: `${table}-new-${++seq}`, ...payload };
        db[table]!.push(row);
        return [row];
      }
      const matched = db[table]!.filter((r) => filters.every((f) => f(r)));
      matched.forEach((r) => Object.assign(r, payload));
      return matched;
    }

    return api;
  }

  return { from: (t: string) => builder(t), rpc: async () => ({ data: false, error: null }) } as any;
}

describe("upsertPrice — property-scope escalation is blocked", () => {
  it("a restaurant_manager scoped to Property A1 CAN set a price at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertPrice(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      menuItemId: "menu-item-1",
      scope: "tenant",
      currency: "TZS",
      amount: 5000,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT set a price at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertPrice(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        menuItemId: "menu-item-1",
        scope: "tenant",
        currency: "TZS",
        amount: 5000,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN set a price at any property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertPrice(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A2,
      menuItemId: "menu-item-1",
      scope: "tenant",
      currency: "TZS",
      amount: 5000,
    } as any);
    expect(created).toBeTruthy();
  });
});

describe("upsertTaxRule — property-scope escalation is blocked", () => {
  it("a general_manager scoped to Property A1 CAN create a tax rule at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertTaxRule(sb, USER_GM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      code: "VAT",
      name: "VAT 18%",
      rate: 18,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a general_manager scoped to Property A1 CANNOT create a tax rule at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertTaxRule(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        code: "VAT",
        name: "VAT 18%",
        rate: 18,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });
});

describe("upsertServiceCharge — property-scope escalation is blocked", () => {
  it("a general_manager scoped to Property A1 CAN create a service charge at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertServiceCharge(sb, USER_GM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      code: "SVC",
      name: "Service Charge 10%",
      rate: 10,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a general_manager scoped to Property A1 CANNOT create a service charge at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertServiceCharge(sb, USER_GM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        code: "SVC",
        name: "Service Charge 10%",
        rate: 10,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });
});

describe("upsertDiscountRule — property-scope escalation is blocked", () => {
  it("a restaurant_manager scoped to Property A1 CAN create a discount rule at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertDiscountRule(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      code: "STAFF10",
      name: "Staff 10% off",
      value: 10,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT create a discount rule at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertDiscountRule(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        code: "STAFF10",
        name: "Staff 10% off",
        value: 10,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });
});
