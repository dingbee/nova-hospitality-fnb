/**
 * Sprint 5.11 — allergen model and propagation. Pure, no I/O.
 *
 * Safety rule of this file: absence of data is never "safe". An unresolved or
 * undeclared component always degrades the result to `verify`.
 */

export const ALLERGENS = [
  "gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "nuts",
  "soy",
  "milk",
  "celery",
  "mustard",
  "sesame",
  "sulphites",
  "lupin",
  "molluscs",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  gluten: "Gluten",
  crustaceans: "Crustaceans",
  eggs: "Eggs",
  fish: "Fish",
  peanuts: "Peanuts",
  nuts: "Tree nuts",
  soy: "Soy",
  milk: "Milk / dairy",
  celery: "Celery",
  mustard: "Mustard",
  sesame: "Sesame",
  sulphites: "Sulphites",
  lupin: "Lupin",
  molluscs: "Molluscs",
};

export type AllergenDeclaration = "unknown" | "declared" | "none";

/** Resolution outcome for a menu item against the full ingredient graph. */
export type AllergenResolution = "contains" | "free" | "verify";

export interface IngredientNode {
  id: string;
  name: string;
  allergens: string[];
  status: AllergenDeclaration;
}

export interface RecipeNode {
  id: string;
  name: string;
  lines: Array<
    | { kind: "ingredient"; ref: string }
    | { kind: "sub_recipe"; ref: string }
  >;
}

export interface AllergenGraph {
  ingredients: Map<string, IngredientNode>;
  recipes: Map<string, RecipeNode>;
}

export interface AllergenProfile {
  allergens: Allergen[];
  /** Component names whose allergen data is missing or unresolvable. */
  unresolved: string[];
  resolution: AllergenResolution;
}

const isAllergen = (v: string): v is Allergen => (ALLERGENS as readonly string[]).includes(v);

/**
 * Recursively resolve allergen exposure for a recipe, following sub-recipes.
 * Cycles are cut and reported as unresolved rather than silently ignored.
 */
export function resolveRecipeAllergens(
  recipeId: string | null,
  graph: AllergenGraph,
  seen: Set<string> = new Set(),
): AllergenProfile {
  if (!recipeId) {
    return { allergens: [], unresolved: ["No recipe linked"], resolution: "verify" };
  }
  if (seen.has(recipeId)) {
    return { allergens: [], unresolved: [`Circular recipe reference (${recipeId})`], resolution: "verify" };
  }
  const recipe = graph.recipes.get(recipeId);
  if (!recipe) {
    return { allergens: [], unresolved: ["Recipe not found"], resolution: "verify" };
  }
  seen.add(recipeId);

  const found = new Set<Allergen>();
  const unresolved: string[] = [];

  if (recipe.lines.length === 0) unresolved.push(`${recipe.name} has no ingredient lines`);

  for (const line of recipe.lines) {
    if (line.kind === "sub_recipe") {
      const sub = resolveRecipeAllergens(line.ref, graph, seen);
      sub.allergens.forEach((a) => found.add(a));
      unresolved.push(...sub.unresolved);
      continue;
    }
    const ing = graph.ingredients.get(line.ref);
    if (!ing) {
      unresolved.push("Unknown ingredient reference");
      continue;
    }
    if (ing.status === "unknown") {
      unresolved.push(ing.name);
      continue;
    }
    for (const a of ing.allergens) if (isAllergen(a)) found.add(a);
  }

  const allergens = [...found].sort();
  const resolution: AllergenResolution =
    unresolved.length > 0 ? "verify" : allergens.length > 0 ? "contains" : "free";
  return { allergens, unresolved: [...new Set(unresolved)], resolution };
}

/**
 * Combine a recipe-derived profile with what the menu item itself declares.
 * Manual declarations add exposure; they never remove an unresolved component.
 */
export function mergeDeclaredAllergens(
  derived: AllergenProfile,
  declared: string[],
  declaredStatus: AllergenDeclaration,
): AllergenProfile {
  const found = new Set<Allergen>(derived.allergens);
  for (const a of declared) if (isAllergen(a)) found.add(a);
  const allergens = [...found].sort();
  if (derived.unresolved.length === 0) {
    return { allergens, unresolved: [], resolution: allergens.length > 0 ? "contains" : "free" };
  }
  // A manual "declared" review can close the gap only when the item itself was reviewed.
  if (declaredStatus === "declared" || declaredStatus === "none") {
    return {
      allergens,
      unresolved: derived.unresolved,
      resolution: allergens.length > 0 ? "contains" : "verify",
    };
  }
  return { allergens, unresolved: derived.unresolved, resolution: "verify" };
}

/** Never returns "safe" — only "no known conflict" or an explicit warning. */
export interface AllergenCheck {
  status: "conflict" | "verify" | "no_known_conflict";
  conflicting: Allergen[];
  headline: string;
  verificationSteps: string[];
}

export function checkAgainstGuestAllergies(
  profile: AllergenProfile,
  guestAllergies: string[],
): AllergenCheck {
  const wanted = guestAllergies.filter(isAllergen);
  if (wanted.length === 0) {
    return { status: "no_known_conflict", conflicting: [], headline: "No allergy recorded.", verificationSteps: [] };
  }
  const conflicting = wanted.filter((a) => profile.allergens.includes(a));
  const steps = [
    "recipe ingredients",
    "modifiers and substitutions",
    "preparation method",
    "cross-contact risk in the kitchen",
  ];
  if (conflicting.length > 0) {
    return {
      status: "conflict",
      conflicting,
      headline: `Contains ${conflicting.map((a) => ALLERGEN_LABEL[a]).join(", ")} — conflicts with a recorded allergy.`,
      verificationSteps: steps,
    };
  }
  if (profile.resolution === "verify") {
    return {
      status: "verify",
      conflicting: [],
      headline: "Verification required — allergen data is incomplete for this item.",
      verificationSteps: steps,
    };
  }
  return {
    status: "no_known_conflict",
    conflicting: [],
    headline: "No known conflict on record. Confirm with the kitchen before serving.",
    verificationSteps: steps,
  };
}