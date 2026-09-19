/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-04: applyDiscount's order-item-scoped path must go through
 * restaurant_apply_giveaway, the only path restaurant_giveaway_guard (DB
 * trigger, migration 0076) permits for writing restaurant_order_items.
 * discount/line_total. Before this fix, applyDiscount wrote those columns
 * directly and the trigger rejected the write unconditionally — proven by
 * a rolled-back reproduction against production, see
 * docs/me-04/ME-04-financial-integrity.md and migration 0078.
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "./__tests__/fakeSupabase";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  isPlatformAdmin: vi.fn(async () => false),
  rolesInTenant: vi.fn(async () => ["owner"]),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const { applyDiscount } = await import("./pricing.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ORDER = "33333333-3333-3333-3333-333333333333";
const ITEM = "44444444-4444-4444-4444-444444444444";

function seed() {
  return makeFakeSupabase({
    restaurant_orders: [
      {
        id: ORDER,
        tenant_id: TENANT,
        currency: "USD",
        subtotal: 10,
        discount_total: 0,
        total: 10,
        status: "open",
      },
    ],
    restaurant_order_items: [
      {
        id: ITEM,
        tenant_id: TENANT,
        order_id: ORDER,
        quantity: 1,
        unit_price: 10,
        discount: 0,
        line_total: 10,
      },
    ],
    restaurant_discount_applications: [],
  });
}

function baseInput() {
  return {
    tenantId: TENANT,
    orderId: ORDER,
    orderItemId: ITEM,
    scope: "product" as const,
    basis: "fixed" as const,
    value: 2,
    reason: "test",
  };
}

describe("applyDiscount — order-item scope goes through restaurant_apply_giveaway", () => {
  it("never writes restaurant_order_items directly; applies only via the RPC", async () => {
    const { sb, store } = seed();
    let appliedId: string | null = null;
    sb.rpc = vi.fn(async (fn: string, args: any) => {
      expect(fn).toBe("restaurant_apply_giveaway");
      appliedId = args._application_id;
      // Mirrors restaurant_apply_giveaway's real single-line effect
      // (migration 0076) so this test also guards the arithmetic
      // invariant: subtotal - discount = total.
      const item: any = (store.get("restaurant_order_items") ?? []).find(
        (r: any) => r.id === ITEM,
      )!;
      const app: any = (store.get("restaurant_discount_applications") ?? []).find(
        (r: any) => r.id === appliedId,
      )!;
      item.discount = app.amount;
      item.line_total = Number((item.quantity * item.unit_price - app.amount).toFixed(2));
      app.applied_at = new Date().toISOString();
      const order: any = (store.get("restaurant_orders") ?? []).find((r: any) => r.id === ORDER)!;
      order.discount_total = item.discount;
      order.total = item.line_total;
      return { data: null, error: null };
    });

    const result = await applyDiscount(sb, USER, baseInput() as any);

    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect(appliedId).not.toBeNull();
    expect(result.application.applied_at).not.toBeNull();

    const item: any = (store.get("restaurant_order_items") ?? []).find((r: any) => r.id === ITEM)!;
    expect(item.discount).toBe(2);
    expect(item.line_total).toBe(8);

    const order: any = (store.get("restaurant_orders") ?? []).find((r: any) => r.id === ORDER)!;
    expect(order.subtotal - order.discount_total).toBe(order.total);
  });

  it("surfaces a rejection from restaurant_apply_giveaway (e.g. a locked business day) and leaves order_items untouched", async () => {
    const { sb, store } = seed();
    sb.rpc = vi.fn(async () => ({
      data: null,
      error: {
        message:
          "That business day is closed. Reopen the day before discounting or comping a bill on it.",
      },
    }));

    await expect(applyDiscount(sb, USER, baseInput() as any)).rejects.toThrow(
      "That business day is closed.",
    );

    const item: any = (store.get("restaurant_order_items") ?? []).find((r: any) => r.id === ITEM)!;
    expect(item.discount).toBe(0);
    expect(item.line_total).toBe(10);
  });
});
