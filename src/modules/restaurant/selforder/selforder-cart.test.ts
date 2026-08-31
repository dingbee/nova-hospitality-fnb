import { describe, expect, it } from "vitest";
import {
  buildChosenModifiers,
  isMissingRequiredModifiers,
  matchModifiersByName,
  resolveVariantUnitPrice,
  toggleModifierSelection,
  toGuestOrderLine,
  type ModifierGroup,
  type ModifierSelection,
  type ProductVariant,
} from "./selforder-cart";

const sizeGroup: ModifierGroup = {
  id: "group-size",
  name: "Spice level",
  min_select: 1,
  max_select: 1,
  required: true,
  modifiers: [
    { id: "mod-mild", group_id: "group-size", name: "Mild", price_delta: 0 },
    { id: "mod-hot", group_id: "group-size", name: "Hot", price_delta: 0 },
  ],
};

const toppingsGroup: ModifierGroup = {
  id: "group-toppings",
  name: "Extra toppings",
  min_select: 0,
  max_select: 2,
  required: false,
  modifiers: [
    { id: "mod-cheese", group_id: "group-toppings", name: "Cheese", price_delta: 1.5 },
    { id: "mod-bacon", group_id: "group-toppings", name: "Bacon", price_delta: 2 },
    { id: "mod-egg", group_id: "group-toppings", name: "Egg", price_delta: 1 },
  ],
};

describe("resolveVariantUnitPrice — variant selection", () => {
  it("returns the base price when no variant is chosen", () => {
    expect(resolveVariantUnitPrice(10, undefined)).toBe(10);
  });

  it("adds the variant's price as a delta on top of the base price when price_is_delta is true", () => {
    const variant: ProductVariant = { id: "v1", name: "Large", price: 2, price_is_delta: true };
    expect(resolveVariantUnitPrice(10, variant)).toBe(12);
  });

  it("uses the variant's price as a standalone absolute price when price_is_delta is false", () => {
    const variant: ProductVariant = { id: "v1", name: "Large", price: 15, price_is_delta: false };
    expect(resolveVariantUnitPrice(10, variant)).toBe(15);
  });

  it("a zero-delta variant (no price difference between options) changes nothing", () => {
    const variant: ProductVariant = { id: "v1", name: "Regular", price: 0, price_is_delta: true };
    expect(resolveVariantUnitPrice(10, variant)).toBe(10);
  });
});

describe("required variant enforcement", () => {
  // restaurant_product_variants carries no required/min-select column,
  // unlike restaurant_modifier_groups — a variant is never mandatory by
  // the existing data model, and PosItemDialog (the till's own picker)
  // doesn't enforce one either. isMissingRequiredModifiers is the one
  // gate order.$tableId.tsx uses to disable "Add to order", and it takes
  // (groups, selected) only — no variant/variantId parameter exists for
  // it to enforce against, so an item with variants but no modifier
  // groups is addable with no variant chosen at all.
  it("an item with variants but no modifier groups is never blocked from being added", () => {
    expect(isMissingRequiredModifiers([], {})).toBe(false);
  });

  it("an item with variants AND a required modifier group is blocked only by the unmet modifier group, never by the missing variant", () => {
    expect(isMissingRequiredModifiers([sizeGroup], {})).toBe(true);
    const spiceChosen: ModifierSelection = { "group-size": new Set(["mod-mild"]) };
    // The required modifier is satisfied; nothing about a variant ever
    // entered this check, and the result correctly unblocks.
    expect(isMissingRequiredModifiers([sizeGroup], spiceChosen)).toBe(false);
  });
});

describe("toggleModifierSelection — modifier selection", () => {
  it("selects a modifier in an empty group", () => {
    const result = toggleModifierSelection({}, sizeGroup, "mod-mild");
    expect(result["group-size"]?.has("mod-mild")).toBe(true);
  });

  it("deselects an already-selected modifier (tap again to clear)", () => {
    const withMild: ModifierSelection = { "group-size": new Set(["mod-mild"]) };
    const result = toggleModifierSelection(withMild, sizeGroup, "mod-mild");
    expect(result["group-size"]?.has("mod-mild")).toBe(false);
  });

  it("a single-select group (max_select 1) replaces the prior pick, never accumulates", () => {
    const withMild: ModifierSelection = { "group-size": new Set(["mod-mild"]) };
    const result = toggleModifierSelection(withMild, sizeGroup, "mod-hot");
    expect([...(result["group-size"] ?? [])]).toEqual(["mod-hot"]);
  });

  it("a multi-select group accumulates picks up to max_select", () => {
    let selection: ModifierSelection = {};
    selection = toggleModifierSelection(selection, toppingsGroup, "mod-cheese");
    selection = toggleModifierSelection(selection, toppingsGroup, "mod-bacon");
    expect([...(selection["group-toppings"] ?? [])].sort()).toEqual(["mod-bacon", "mod-cheese"]);
  });

  it("refuses a new pick once max_select is reached, existing picks untouched", () => {
    let selection: ModifierSelection = {};
    selection = toggleModifierSelection(selection, toppingsGroup, "mod-cheese");
    selection = toggleModifierSelection(selection, toppingsGroup, "mod-bacon");
    const atLimit = toggleModifierSelection(selection, toppingsGroup, "mod-egg");
    expect([...(atLimit["group-toppings"] ?? [])].sort()).toEqual(["mod-bacon", "mod-cheese"]);
  });

  it("groups are independent — toggling one never touches another", () => {
    let selection: ModifierSelection = {};
    selection = toggleModifierSelection(selection, sizeGroup, "mod-mild");
    selection = toggleModifierSelection(selection, toppingsGroup, "mod-cheese");
    expect([...(selection["group-size"] ?? [])]).toEqual(["mod-mild"]);
    expect([...(selection["group-toppings"] ?? [])]).toEqual(["mod-cheese"]);
  });
});

describe("required modifier enforcement", () => {
  it("blocks when a required group has no selection", () => {
    expect(isMissingRequiredModifiers([sizeGroup], {})).toBe(true);
  });

  it("unblocks once the required group's minimum is met", () => {
    const selection: ModifierSelection = { "group-size": new Set(["mod-mild"]) };
    expect(isMissingRequiredModifiers([sizeGroup], selection)).toBe(false);
  });

  it("an optional group with nothing selected never blocks", () => {
    expect(isMissingRequiredModifiers([toppingsGroup], {})).toBe(false);
  });

  it("one satisfied required group and one untouched optional group together don't block", () => {
    const selection: ModifierSelection = { "group-size": new Set(["mod-hot"]) };
    expect(isMissingRequiredModifiers([sizeGroup, toppingsGroup], selection)).toBe(false);
  });

  it("a required group with min_select 2 isn't satisfied by a single pick", () => {
    const twoRequired: ModifierGroup = { ...sizeGroup, max_select: 2, min_select: 2 };
    const selection: ModifierSelection = { "group-size": new Set(["mod-mild"]) };
    expect(isMissingRequiredModifiers([twoRequired], selection)).toBe(true);
  });
});

describe("buildChosenModifiers", () => {
  it("expands selected ids into the submitted SalesLineModifier shape, price deltas included", () => {
    const selection: ModifierSelection = {
      "group-size": new Set(["mod-hot"]),
      "group-toppings": new Set(["mod-cheese", "mod-bacon"]),
    };
    const result = buildChosenModifiers([sizeGroup, toppingsGroup], selection);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({
      modifierId: "mod-hot",
      groupId: "group-size",
      name: "Hot",
      priceDelta: 0,
      quantity: 1,
    });
    expect(result).toContainEqual({
      modifierId: "mod-cheese",
      groupId: "group-toppings",
      name: "Cheese",
      priceDelta: 1.5,
      quantity: 1,
    });
  });

  it("returns an empty array when nothing is selected", () => {
    expect(buildChosenModifiers([sizeGroup, toppingsGroup], {})).toEqual([]);
  });
});

describe("toGuestOrderLine — submitted payload, guest notes", () => {
  it("carries variantId and notes through to the submitted line", () => {
    const line = toGuestOrderLine({
      menuItemId: "item-1",
      name: "Burger — Large",
      quantity: 2,
      modifiers: [],
      variantId: "variant-large",
      notes: "No onions",
    });
    expect(line).toEqual({
      menuItemId: "item-1",
      description: "Burger — Large",
      quantity: 2,
      unitPrice: 0,
      discount: 0,
      modifiers: [],
      variantId: "variant-large",
      notes: "No onions",
    });
  });

  it("unitPrice and discount are always 0 regardless of any client-side price estimate — the server is the sole pricing authority", () => {
    const line = toGuestOrderLine({
      menuItemId: "item-1",
      name: "Burger",
      quantity: 1,
      modifiers: [],
    });
    expect(line.unitPrice).toBe(0);
    expect(line.discount).toBe(0);
  });

  it("omits variantId and notes when neither was set — no fabricated values sent", () => {
    const line = toGuestOrderLine({
      menuItemId: "item-1",
      name: "Burger",
      quantity: 1,
      modifiers: [],
    });
    expect(line.variantId).toBeUndefined();
    expect(line.notes).toBeUndefined();
  });

  it("passes selected modifiers through unchanged", () => {
    const modifiers = [
      { modifierId: "mod-hot", groupId: "group-size", name: "Hot", priceDelta: 0, quantity: 1 },
    ];
    const line = toGuestOrderLine({
      menuItemId: "item-1",
      name: "Burger",
      quantity: 1,
      modifiers,
    });
    expect(line.modifiers).toBe(modifiers);
  });
});

describe("matchModifiersByName — GEP2", () => {
  it("resolves a real modifier name (case-insensitive) to its full SalesLineModifier shape", () => {
    const result = matchModifiersByName([toppingsGroup], ["cheese"]);
    expect(result).toEqual([
      {
        modifierId: "mod-cheese",
        groupId: "group-toppings",
        name: "Cheese",
        priceDelta: 1.5,
        quantity: 1,
      },
    ]);
  });

  it("never fabricates a modifier for a name that doesn't exist in any group", () => {
    const result = matchModifiersByName([toppingsGroup], ["Truffle shavings"]);
    expect(result).toEqual([]);
  });

  it("resolves multiple real names across multiple groups", () => {
    const result = matchModifiersByName([sizeGroup, toppingsGroup], ["Hot", "bacon"]);
    expect(result.map((m) => m.name).sort()).toEqual(["Bacon", "Hot"]);
  });
});
