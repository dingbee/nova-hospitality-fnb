/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — configuration governance, expanded coverage.
 *
 * `menu.property-scope.test.ts` proved the config-governance fix
 * (0062_p09_config_governance_property_scope.sql) for one representative
 * table (menus). This file proves the identical fix for kitchen stations:
 * upsertStation calls `assertCapability(sb, userId, tenantId,
 * "kitchen.manage", { propertyId, locationId })` — restaurant_stations
 * has a real property_id column the caller controls directly. Does NOT
 * mock "../core/access.server", so the real property-scope logic
 * actually runs.
 */
import { describe, expect, it } from "vitest";
import { upsertStation } from "./kitchen.server";

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_RM_A1 = "rm-a1"; // restaurant_manager scoped to Property A1 — covers kitchen.manage
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide";

function makeFakeSupabase() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_RM_A1, role: "restaurant_manager", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_OWNER_TENANT_WIDE, role: "owner", property_id: null },
  ];
  const stations: any[] = [];
  let seq = 0;

  function table(name: string) {
    let op: "select" | "insert" = "select";
    let payload: any = null;
    const filters: Array<(r: any) => boolean> = [];

    function rows(): any[] {
      if (name === "restaurant_members") return members;
      if (name === "restaurant_stations") return stations;
      return [];
    }

    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      single: async () => {
        if (op === "insert") {
          const stored = { id: `${name}-new-${++seq}`, ...payload };
          rows().push(stored);
          return { data: stored, error: null };
        }
        return { data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
      },
      then(resolve: any) {
        resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null });
      },
    };
    return api;
  }

  return { from: table, rpc: async () => ({ data: false, error: null }) } as any;
}

describe("upsertStation — property-scope escalation is blocked", () => {
  it("a restaurant_manager scoped to Property A1 CAN create a station at their own property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertStation(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A1,
      code: "KITCHEN",
      name: "Main Kitchen",
    } as any);
    expect(created).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT create a station at sibling Property A2", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertStation(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        code: "KITCHEN",
        name: "Main Kitchen",
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN create a station at any property", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertStation(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      propertyId: PROPERTY_A2,
      code: "BAR",
      name: "Main Bar",
    } as any);
    expect(created).toBeTruthy();
  });
});
