/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-13 — repeated authorization resolution.
 *
 * openPosOrder → createOrder → addPosLines and
 * takePosPayment → transitionOrder → issueReceipt each independently called
 * assertCapability, which independently called isPlatformAdmin (an RPC) +
 * memberGrantsInTenant (a table query) — 2-3 authorization resolutions (4-6
 * round trips) for one logical POS action, all with the identical
 * (userId, tenantId) arguments.
 *
 * These tests exercise the REAL access.server.ts (not mocked) against a
 * counting fake Supabase client, so the assertion is about actual database
 * round trips, not about a mocked stand-in for the authorization check.
 * They fail if any of the touched call sites in pos.server.ts,
 * sales.server.ts or receipts.server.ts stop threading the resolved
 * TenantScope through — the exact regression this pass closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addPosLines, openPosOrder, takePosPayment } from "./pos.server";
import { getTenantScope } from "../core/access.server";

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));
vi.mock("../kitchen/kitchen.server", () => ({
  cancelKitchenTicketItemsForOrderItems: vi.fn(async () => undefined),
}));

const TENANT = "tenant-1";
const USER = "user-1";
const PROPERTY = "property-1";

let hasAnyRoleCalls = 0;
let memberGrantsCalls = 0;

function makeFakeSupabase() {
  hasAnyRoleCalls = 0;
  memberGrantsCalls = 0;

  const tables: Record<string, any[]> = {
    restaurant_orders: [],
    restaurant_order_items: [],
    restaurant_payments: [],
    restaurant_receipts: [],
    restaurant_members: [{ tenant_id: TENANT, user_id: USER, role: "owner", property_id: null }],
    restaurant_tables: [],
  };
  let seq = 0;

  function from(table: string) {
    const isMemberLookup = table === "restaurant_members";
    let filtered = tables[table] ?? (tables[table] = []);
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      order: () => api,
      limit: () => api,
      in: () => api,
      gte: () => api,
      lte: () => api,
      gt: () => api,
      then: (resolve: (v: { data: any[]; error: null }) => unknown) => {
        if (isMemberLookup) memberGrantsCalls++;
        return resolve({ data: filtered, error: null });
      },
      maybeSingle: async () => {
        if (isMemberLookup) memberGrantsCalls++;
        return { data: filtered[0] ?? null, error: null };
      },
      single: async () =>
        filtered.length
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: `${table}: not found` } },
      insert: (row: any) => {
        const stored = { id: row.id ?? `${table}-${++seq}`, ...row };
        tables[table]!.push(stored);
        filtered = [stored];
        return {
          select: () => ({ single: async () => ({ data: stored, error: null }) }),
        };
      },
      update: (patch: any) => {
        let lastMatched: any[] = tables[table]!;
        const target: any = {
          eq: (col: string, val: unknown) => {
            lastMatched = lastMatched.filter((r) => r[col] === val);
            for (const r of lastMatched) Object.assign(r, patch);
            return target;
          },
          select: () => ({
            single: async () =>
              lastMatched.length
                ? { data: lastMatched[0], error: null }
                : { data: null, error: { message: "not found" } },
          }),
        };
        return target;
      },
    };
    return api;
  }

  async function rpc(fn: string, _args: any) {
    if (fn === "has_any_role") {
      hasAnyRoleCalls++;
      return { data: false, error: null }; // never a platform admin — forces the real grants-check path
    }
    if (fn === "restaurant_next_document_number") {
      return { data: `RCP-${++seq}`, error: null };
    }
    return { data: null, error: null };
  }

  return { from, rpc, tables } as any;
}

describe("ME-13: authorization resolution is not repeated within one logical POS action", () => {
  beforeEach(() => {
    hasAnyRoleCalls = 0;
    memberGrantsCalls = 0;
  });

  it("openPosOrder resolves authorization exactly once, not once per internal call (createOrder)", async () => {
    const sb = makeFakeSupabase();
    const order = await openPosOrder(sb, USER, {
      tenantId: TENANT,
      propertyId: PROPERTY,
      orderType: "dine_in",
      guestCount: 2,
      currency: "TZS",
      lines: [],
    } as any);

    expect(order.idempotent).toBe(false);
    // Before this pass: openPosOrder's own check + createOrder's own check
    // = 2 independent resolutions (2 RPC calls, 2 member-grant queries).
    // After: getTenantScope is resolved once and threaded through both.
    expect(hasAnyRoleCalls).toBe(1);
    expect(memberGrantsCalls).toBe(1);
  });

  it("takePosPayment(closeWhenSettled) resolves authorization exactly once across takePosPayment → transitionOrder → issueReceipt", async () => {
    const sb = makeFakeSupabase();
    const orderId = "order-1";
    sb.tables.restaurant_orders.push({
      id: orderId,
      tenant_id: TENANT,
      property_id: PROPERTY,
      location_id: null,
      status: "open",
      total: 40,
      paid_total: 0,
      currency: "TZS",
      order_number: "ORD-1",
    });

    const result = await takePosPayment(sb, USER, {
      tenantId: TENANT,
      orderId,
      method: "cash",
      amount: 40,
      state: "paid",
      closeWhenSettled: true,
    } as any);

    expect(result.settled).toBe(true);
    expect((result.order as any).status).toBe("closed");
    // Before this pass: takePosPayment's own check + transitionOrder's own
    // check + issueReceipt's own check = 3 independent resolutions (3 RPC
    // calls, 3 member-grant queries) for one "take payment and close" action.
    // After: getTenantScope is resolved once in takePosPayment and threaded
    // through transitionOrder and issueReceipt.
    expect(hasAnyRoleCalls).toBe(1);
    expect(memberGrantsCalls).toBe(1);
  });

  it("addPosLines reuses a pre-resolved TenantScope instead of re-querying it", async () => {
    const sb = makeFakeSupabase();
    const orderId = "order-2";
    sb.tables.restaurant_orders.push({
      id: orderId,
      tenant_id: TENANT,
      property_id: PROPERTY,
      location_id: null,
      status: "open",
      order_number: "ORD-2",
      currency: "TZS",
      order_type: "dine_in",
      exchange_rate: 1,
    });

    // Resolved once by the caller (as openPosOrder now does), exactly like
    // production wiring — not re-derived inside addPosLines.
    const tenantScope = await getTenantScope(sb, USER, TENANT);
    expect(hasAnyRoleCalls).toBe(1);
    expect(memberGrantsCalls).toBe(1);

    await addPosLines(sb, USER, { tenantId: TENANT, orderId, lines: [] } as any, tenantScope);

    // addPosLines's own assertCapability call must reuse the passed-in
    // scope — zero additional authorization round trips.
    expect(hasAnyRoleCalls).toBe(1);
    expect(memberGrantsCalls).toBe(1);
  });
});
