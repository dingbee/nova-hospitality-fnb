import { describe, expect, it } from "vitest";
import {
  evaluateRoomChargeEligibility,
  folioIdempotencyKey,
  folioFailureMessage,
  type FolioStay,
} from "@/domains/hospitality/folio/folio.rules";
import {
  flattenComposition,
  mergeComponents,
  servingsAvailable,
  limitingComponent,
  compositionCost,
  CircularCompositionError,
  type CompositionNodeInput,
} from "@/modules/restaurant/products/composition";
import { detectRoomChargeExceptions } from "@/modules/restaurant/reconciliation/calc";

const stay: FolioStay = {
  bookingId: "b1",
  guestName: "A Guest",
  unitLabel: "12",
  roomName: "River Suite",
  arrival: "2026-01-01",
  departure: "2026-01-04",
  currency: "TZS",
  status: "checked_in",
};

describe("folio eligibility", () => {
  it("allows a charge on an active stay in the same currency", () => {
    expect(evaluateRoomChargeEligibility(stay, { amount: 10_000, currency: "TZS" }).eligible).toBe(true);
  });
  it("refuses when no stay is found", () => {
    expect(evaluateRoomChargeEligibility(null, { amount: 100, currency: "TZS" }).code).toBe("guest_not_found");
  });
  it("refuses a stay that is not checked in", () => {
    expect(evaluateRoomChargeEligibility({ ...stay, status: "checked_out" }, { amount: 100, currency: "TZS" }).code).toBe(
      "stay_not_active",
    );
  });
  it("refuses a currency mismatch", () => {
    expect(evaluateRoomChargeEligibility(stay, { amount: 100, currency: "USD" }).code).toBe("currency_mismatch");
  });
  it("refuses a zero or negative amount", () => {
    expect(evaluateRoomChargeEligibility(stay, { amount: 0, currency: "TZS" }).code).toBe("invalid_amount");
  });
  it("returns a human message for every failure", () => {
    expect(folioFailureMessage("pms_unavailable")).toContain("did not answer");
  });
  it("produces a stable idempotency key", () => {
    const args = { tenantId: "t", orderId: "o", clientRequestId: "c" };
    expect(folioIdempotencyKey(args)).toBe(folioIdempotencyKey(args));
  });
});

const graph = new Map<string, CompositionNodeInput>([
  [
    "cocktail",
    {
      recipeId: "cocktail",
      yieldQuantity: 1,
      lines: [
        { id: "l1", componentKind: "inventory_item", inventoryItemId: "gin", quantity: 0.05, yieldPercent: 100 },
        { id: "l2", componentKind: "sub_recipe", subRecipeId: "syrup", quantity: 0.02, yieldPercent: 100 },
        { id: "l3", componentKind: "inventory_item", inventoryItemId: "mint", quantity: 1, isOptional: true },
      ],
    },
  ],
  [
    "syrup",
    {
      recipeId: "syrup",
      yieldQuantity: 1,
      lines: [{ id: "s1", componentKind: "inventory_item", inventoryItemId: "sugar", quantity: 1, yieldPercent: 100 }],
    },
  ],
]);

describe("beverage composition", () => {
  const components = mergeComponents(flattenComposition("cocktail", graph));

  it("explodes unstocked sub-recipes into their ingredients", () => {
    expect(components.map((c) => c.inventoryItemId).sort()).toEqual(["gin", "mint", "sugar"]);
  });
  it("stops at a stocked sub-recipe", () => {
    const stocked = new Map(graph);
    stocked.set("syrup", { ...graph.get("syrup")!, producesInventoryItemId: "syrup-btl" });
    const out = mergeComponents(flattenComposition("cocktail", stocked));
    expect(out.some((c) => c.inventoryItemId === "syrup-btl")).toBe(true);
    expect(out.some((c) => c.inventoryItemId === "sugar")).toBe(false);
  });
  it("caps servings on the binding ingredient and ignores optionals", () => {
    const onHand = (id: string) => ({ gin: 0.5, sugar: 10, mint: 0 })[id] ?? 0;
    expect(servingsAvailable(components, onHand)).toBe(10);
    expect(limitingComponent(components, onHand)?.inventoryItemId).toBe("gin");
  });
  it("costs a serving from component costs", () => {
    expect(compositionCost(components, (id) => (id === "gin" ? 100 : 10))).toBeCloseTo(0.05 * 100 + 0.02 * 10 + 10, 4);
  });
  it("refuses a recipe that contains itself", () => {
    const loop = new Map<string, CompositionNodeInput>([
      ["a", { recipeId: "a", yieldQuantity: 1, lines: [{ id: "x", componentKind: "sub_recipe", subRecipeId: "b", quantity: 1 }] }],
      ["b", { recipeId: "b", yieldQuantity: 1, lines: [{ id: "y", componentKind: "sub_recipe", subRecipeId: "a", quantity: 1 }] }],
    ]);
    expect(() => flattenComposition("a", loop)).toThrow(CircularCompositionError);
  });
});

const payment = (over: Partial<any> = {}) => ({
  id: "p1",
  order_id: "o1",
  method: "room_charge",
  state: "room_charged",
  amount: 50_000,
  ...over,
});

describe("room charge reconciliation", () => {
  it("flags a room charge with no folio posting as critical", () => {
    const drafts = detectRoomChargeExceptions("2026-01-01", [payment()] as any, []);
    expect(drafts[0]?.code).toBe("payment.room_charge_unposted");
    expect(drafts[0]?.severity).toBe("critical");
  });
  it("flags an unconfirmed posting separately", () => {
    const drafts = detectRoomChargeExceptions("2026-01-01", [payment()] as any, [
      { id: "f1", source_order_id: "o1", amount: 50_000, status: "unknown" },
    ]);
    expect(drafts[0]?.code).toBe("payment.room_charge_unknown");
  });
  it("accepts a matched posting", () => {
    const drafts = detectRoomChargeExceptions("2026-01-01", [payment()] as any, [
      { id: "f1", source_order_id: "o1", amount: 50_000, status: "posted" },
    ]);
    expect(drafts).toHaveLength(0);
  });
  it("flags a folio posting the outlet never settled", () => {
    const drafts = detectRoomChargeExceptions("2026-01-01", [], [
      { id: "f2", source_order_id: "o9", amount: 20_000, status: "posted", booking_id: "b1" },
    ]);
    expect(drafts[0]?.code).toBe("payment.room_charge_orphaned");
  });
});
