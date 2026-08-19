import { describe, expect, it } from "vitest";
import { allowedLifecycleActions, evaluateDeletion, nextLifecycleState } from "./lifecycle";
import { checkAgainstGuestAllergies, resolveRecipeAllergens, type AllergenGraph } from "./allergens";
import { conflictsWithDiet, parseGuestStatement, promoteState } from "../guest/dietary";
import { deriveConfidence, derivePriority } from "../intelligence/opportunities";

const graph = (): AllergenGraph => ({
  ingredients: new Map([
    ["flour", { id: "flour", name: "Flour", allergens: ["gluten"], status: "declared" as const }],
    ["salt", { id: "salt", name: "Salt", allergens: [], status: "none" as const }],
    ["mystery", { id: "mystery", name: "Mystery paste", allergens: [], status: "unknown" as const }],
  ]),
  recipes: new Map([
    ["dough", { id: "dough", name: "Dough", lines: [{ kind: "ingredient" as const, ref: "flour" }] }],
    [
      "pizza",
      {
        id: "pizza",
        name: "Pizza",
        lines: [
          { kind: "sub_recipe" as const, ref: "dough" },
          { kind: "ingredient" as const, ref: "salt" },
        ],
      },
    ],
    ["risky", { id: "risky", name: "Risky", lines: [{ kind: "ingredient" as const, ref: "mystery" }] }],
  ]),
});

describe("menu lifecycle", () => {
  it("only allows legal transitions", () => {
    expect(nextLifecycleState("draft", "activate")).toBe("active");
    expect(nextLifecycleState("draft", "pause")).toBeNull();
    expect(allowedLifecycleActions("archived")).toContain("restore");
  });

  it("refuses deletion when history exists", () => {
    expect(evaluateDeletion({ orderLines: 0, documents: 0, derivedRecords: 0 }).deletable).toBe(true);
    const blocked = evaluateDeletion({ orderLines: 4, documents: 0, derivedRecords: 0 });
    expect(blocked.deletable).toBe(false);
  });
});

describe("allergen resolution", () => {
  it("propagates through sub-recipes", () => {
    expect(resolveRecipeAllergens("pizza", graph()).allergens).toEqual(["gluten"]);
  });

  it("requires verification when data is missing", () => {
    const p = resolveRecipeAllergens("risky", graph());
    expect(p.resolution).toBe("verify");
    expect(p.unresolved).toContain("Mystery paste");
  });

  it("never claims safety, only absence of known conflict", () => {
    const check = checkAgainstGuestAllergies(resolveRecipeAllergens("pizza", graph()), ["gluten"]);
    expect(check.status).toBe("conflict");
    const unknown = checkAgainstGuestAllergies(resolveRecipeAllergens("risky", graph()), ["gluten"]);
    expect(unknown.status).toBe("verify");
  });
});

describe("guest dietary context", () => {
  it("detects diet conflicts from item text", () => {
    expect(conflictsWithDiet("vegetarian", { name: "Grilled chicken" })).toBe("chicken");
    expect(conflictsWithDiet("vegetarian", { name: "Garden salad" })).toBeNull();
  });

  it("parses statements without over-claiming", () => {
    expect(parseGuestStatement("I am vegetarian")?.kind).toBe("dietary_requirement");
    expect(parseGuestStatement("hi")).toBeNull();
  });

  it("promotes state only with repetition or confirmation", () => {
    expect(promoteState("observed", 1, false)).toBe("observed");
    expect(promoteState("observed", 3, false)).toBe("recurring");
    expect(promoteState("observed", 1, true)).toBe("confirmed");
  });
});

describe("opportunity scoring", () => {
  it("returns null confidence without enough hard evidence", () => {
    expect(deriveConfidence([{ label: "a", value: "1", strength: "hard", weight: 1 }])).toBeNull();
  });

  it("penalises blocked opportunities", () => {
    const open = derivePriority("overstock", 0.8, null, []);
    const blocked = derivePriority("overstock", 0.8, null, ["no recipe"]);
    expect(blocked).toBeLessThan(open);
  });
});