/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * bulkUpsertPrices — proves bulk configuration is exactly N calls to the
 * same governed upsertPrice (spec section 4/16): real versioning, real
 * supersession, real approval gating, and a per-line failure that never
 * aborts the rest of the batch.
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "./__tests__/fakeSupabase";
import { bulkUpsertPricesSchema } from "./contracts";

const assertCapability = vi.fn(async (..._args: any[]) => true);
vi.mock("../core/access.server", () => ({
  assertCapability: (...args: any[]) => assertCapability(...args),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const { bulkUpsertPrices } = await import("./pricing.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LOCATION = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    locationId: LOCATION,
    scope: "location" as const,
    channel: "dine_in" as const,
    priceListId: null,
    currency: "TZS",
    taxInclusive: false,
    requiresApproval: false,
    lines: [
      { menuItemId: ITEM_A, amount: 18000 },
      { menuItemId: ITEM_B, amount: 14000 },
    ],
    ...overrides,
  };
}

describe("bulkUpsertPrices", () => {
  it("creates one active price version per item, through the real upsertPrice", async () => {
    const { sb, store } = makeFakeSupabase({ restaurant_prices: [] });
    const result = await bulkUpsertPrices(sb, USER, baseInput() as any);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    const rows = store.get("restaurant_prices") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.status === "active")).toBe(true);
    expect(rows.map((r: any) => r.amount).sort()).toEqual([14000, 18000]);
  });

  it("supersedes the previous active price on a second configuration of the same item/scope — never overwrites history", async () => {
    const { sb, store } = makeFakeSupabase({ restaurant_prices: [] });
    await bulkUpsertPrices(
      sb,
      USER,
      baseInput({ lines: [{ menuItemId: ITEM_A, amount: 18000 }] }) as any,
    );
    await bulkUpsertPrices(
      sb,
      USER,
      baseInput({ lines: [{ menuItemId: ITEM_A, amount: 19000 }] }) as any,
    );

    const rows = (store.get("restaurant_prices") ?? []).filter(
      (r: any) => r.menu_item_id === ITEM_A,
    );
    expect(rows).toHaveLength(2);
    const active = rows.find((r: any) => r.status === "active")!;
    const superseded = rows.find((r: any) => r.status === "superseded")!;
    expect(active.amount).toBe(19000);
    expect(active.version).toBe(2);
    expect(superseded.amount).toBe(18000);
    expect(superseded.version).toBe(1);
  });

  it("lands as pending_approval and does not supersede the current active price until a human approves it", async () => {
    const { sb, store } = makeFakeSupabase({ restaurant_prices: [] });
    await bulkUpsertPrices(
      sb,
      USER,
      baseInput({ lines: [{ menuItemId: ITEM_A, amount: 18000 }] }) as any,
    );
    await bulkUpsertPrices(
      sb,
      USER,
      baseInput({ requiresApproval: true, lines: [{ menuItemId: ITEM_A, amount: 25000 }] }) as any,
    );

    const rows = (store.get("restaurant_prices") ?? []).filter(
      (r: any) => r.menu_item_id === ITEM_A,
    );
    const active = rows.find((r: any) => r.status === "active")!;
    const pending = rows.find((r: any) => r.status === "pending_approval")!;
    expect(active.amount).toBe(18000); // untouched — still the live price
    expect(pending.amount).toBe(25000);
  });

  it("a per-line failure never aborts the rest of the batch", async () => {
    const { sb, store } = makeFakeSupabase({ restaurant_prices: [] });
    assertCapability.mockImplementationOnce(async () => {
      throw new Error("not authorized for this scope");
    });

    const result = await bulkUpsertPrices(sb, USER, baseInput() as any);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const failedLine = result.results.find((r) => !r.ok)!;
    expect(failedLine.menuItemId).toBeDefined();
    expect((failedLine as any).error).toMatch(/not authorized/i);
    // The other line still went through.
    expect((store.get("restaurant_prices") ?? []).length).toBe(1);
  });

  it("channel and price list are applied identically to every line", async () => {
    const { sb, store } = makeFakeSupabase({ restaurant_prices: [] });
    await bulkUpsertPrices(
      sb,
      USER,
      baseInput({ channel: "takeaway", priceListId: "pl-1" }) as any,
    );
    const rows = store.get("restaurant_prices") ?? [];
    expect(rows.every((r: any) => r.channel === "takeaway")).toBe(true);
    expect(rows.every((r: any) => r.price_list_id === "pl-1")).toBe(true);
  });
});

describe("bulkUpsertPricesSchema — amount validation (spec section 16)", () => {
  it("rejects a negative amount", () => {
    expect(() =>
      bulkUpsertPricesSchema.parse(baseInput({ lines: [{ menuItemId: ITEM_A, amount: -100 }] })),
    ).toThrow();
  });

  it("rejects an empty batch", () => {
    expect(() => bulkUpsertPricesSchema.parse(baseInput({ lines: [] }))).toThrow();
  });

  it("rejects a non-numeric amount", () => {
    expect(() =>
      bulkUpsertPricesSchema.parse(
        baseInput({ lines: [{ menuItemId: ITEM_A, amount: "eighteen thousand" }] }),
      ),
    ).toThrow();
  });

  it("accepts a well-formed batch", () => {
    expect(() => bulkUpsertPricesSchema.parse(baseInput())).not.toThrow();
  });
});
