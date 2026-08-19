/**
 * Recipe master source parsing — pure, deterministic, and never inventive.
 *
 * The recipe books were written for cooks, not for a database: quantities come
 * as ranges, units include prose ("to taste", "as required"), and only some
 * ingredients carry a candidate SKU. This module translates what is
 * unambiguous and *flags* everything else. It never guesses a unit, a
 * conversion, a quantity or a stock item.
 */

export interface RecipeSourceRecipe {
  sourceRow: number;
  recipeId: string;
  name: string;
  servicePeriod: string | null;
  sourceSection: string | null;
  portionBasis: string | null;
  importStatus: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  preparationMethod: string | null;
  version?: number | null;
}

export interface RecipeSourceLine {
  sourceRow: number;
  recipeId: string;
  recipeName: string | null;
  ingredientName: string | null;
  quantityMin: number | null;
  quantityMax: number | null;
  unit: string | null;
  candidateSku: string | null;
  mappingStatus: string | null;
  methodOrNotes: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
}

/** Source recipe unit label → unit code in `restaurant_inventory_units`. */
const RECIPE_UNIT_CODES: Record<string, string> = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  ml: "ml",
  l: "l",
  litre: "l",
  piece: "ea",
  pieces: "ea",
  pc: "ea",
  pcs: "ea",
  portion: "portion",
};

/** Units the source expresses as prose — never silently converted. */
const NON_NUMERIC_UNITS = new Set(["as required", "to taste"]);

export type LineMappingIntent = "candidate" | "match_required";

export interface NormalisedRecipeLine {
  recipeCode: string;
  sourceRow: number;
  ingredientName: string;
  /** Authoritative planning quantity: the minimum of a supplied range. */
  quantity: number;
  quantityMin: number | null;
  quantityMax: number | null;
  hasRange: boolean;
  sourceUnit: string | null;
  unitCode: string | null;
  candidateSku: string | null;
  mappingIntent: LineMappingIntent;
  notes: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  issues: string[];
}

export function recipeUnitCode(label: string | null | undefined): string | null {
  if (!label) return null;
  return RECIPE_UNIT_CODES[label.trim().toLowerCase()] ?? null;
}

export function isProseUnit(label: string | null | undefined): boolean {
  return !!label && NON_NUMERIC_UNITS.has(label.trim().toLowerCase());
}

export function normaliseRecipeLine(row: RecipeSourceLine): NormalisedRecipeLine {
  const issues: string[] = [];
  const sourceUnit = row.unit?.trim() || null;
  const unitCode = recipeUnitCode(sourceUnit);
  const min = row.quantityMin ?? null;
  const max = row.quantityMax ?? null;

  if (min === null && max === null) {
    issues.push("No quantity supplied in the source recipe.");
  } else if (min !== null && max !== null && max < min) {
    issues.push("Maximum quantity is lower than the minimum quantity.");
  }
  if (!sourceUnit) issues.push("No unit supplied in the source recipe.");
  else if (isProseUnit(sourceUnit))
    issues.push(`Unit "${sourceUnit}" is a written instruction, not a measure.`);
  else if (!unitCode) issues.push(`Unit "${sourceUnit}" has no equivalent in the unit system.`);

  const intent: LineMappingIntent =
    row.candidateSku && row.mappingStatus?.trim().toUpperCase() !== "MATCH_REQUIRED"
      ? "candidate"
      : "match_required";
  if (intent === "match_required")
    issues.push("No candidate stock item supplied — manual match required.");

  return {
    recipeCode: row.recipeId.trim(),
    sourceRow: row.sourceRow,
    ingredientName: (row.ingredientName ?? "Unnamed ingredient").trim(),
    quantity: min ?? max ?? 0,
    quantityMin: min,
    quantityMax: max,
    hasRange: min !== null && max !== null && Math.abs(max - min) > 1e-9,
    sourceUnit,
    unitCode,
    candidateSku: row.candidateSku?.trim() || null,
    mappingIntent: intent,
    notes: row.methodOrNotes?.trim() || null,
    sourceFile: row.sourceFile ?? null,
    sourceSheet: row.sourceSheet ?? null,
    issues,
  };
}

export interface NormalisedRecipe {
  code: string;
  name: string;
  version: number;
  servicePeriod: string | null;
  sourceSection: string | null;
  portionBasis: string | null;
  importStatus: string | null;
  instructions: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  sourceRow: number;
}

export function normaliseRecipe(row: RecipeSourceRecipe): NormalisedRecipe {
  return {
    code: row.recipeId.trim(),
    name: row.name.trim(),
    version: Number(row.version ?? 1) || 1,
    servicePeriod: row.servicePeriod?.trim() ?? null,
    sourceSection: row.sourceSection?.trim() ?? null,
    portionBasis: row.portionBasis?.trim() ?? null,
    importStatus: row.importStatus?.trim() ?? null,
    instructions: row.preparationMethod?.trim() || null,
    sourceFile: row.sourceFile ?? null,
    sourceSheet: row.sourceSheet ?? null,
    sourceRow: row.sourceRow,
  };
}

/** Dimension compatibility between a recipe unit and a stock item's base unit. */
export function unitsComparable(
  recipeUnit: { dimension: string } | null | undefined,
  itemUnit: { dimension: string } | null | undefined,
): boolean {
  if (!recipeUnit || !itemUnit) return false;
  return recipeUnit.dimension === itemUnit.dimension;
}
