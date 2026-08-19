/**
 * Product, Recipe & Production contracts (Sprint 5.3) — browser-safe.
 *
 * The vocabulary this module insists on, and never conflates:
 *   inventory item   — something held in stock
 *   recipe           — how something is produced (versioned)
 *   sub-recipe       — a reusable recipe consumed by another recipe
 *   production       — a run that turns ingredients into finished stock
 *   menu product     — something sold (may or may not have a recipe)
 *   modifier         — a sale-time adjustment (price, and sometimes stock)
 *   variant          — a size/option of a product
 *   bundle           — one sellable line resolving to component products
 */
import { z } from "zod";

const uuid = z.string().uuid();
const scope = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
});

export const RECIPE_STATUSES = ["draft", "active", "inactive", "archived"] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

export const RECIPE_KINDS = ["menu", "sub_recipe", "production"] as const;
export type RecipeKind = (typeof RECIPE_KINDS)[number];

export const RECIPE_COMPONENT_KINDS = ["inventory_item", "sub_recipe"] as const;
export type RecipeComponentKind = (typeof RECIPE_COMPONENT_KINDS)[number];

export const PRODUCTION_STATUSES = ["draft", "in_progress", "completed", "cancelled"] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const PRODUCT_TYPES = ["standard", "retail", "variant_parent", "bundle"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const MODIFIER_EFFECTS = ["none", "inventory", "recipe"] as const;
export type ModifierEffect = (typeof MODIFIER_EFFECTS)[number];

/* ---------------- Recipes ---------------- */

export const listRecipesSchema = scope.extend({
  kind: z.enum(RECIPE_KINDS).optional(),
  status: z.enum(RECIPE_STATUSES).optional(),
  search: z.string().max(120).optional(),
  /** Only the newest version of each lineage. */
  latestOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(400).default(200),
});

export const recipeLineInputSchema = z.object({
  id: uuid.optional(),
  componentKind: z.enum(RECIPE_COMPONENT_KINDS).default("inventory_item"),
  inventoryItemId: uuid.nullish(),
  subRecipeId: uuid.nullish(),
  quantity: z.number().min(0),
  unitId: uuid.nullish(),
  yieldPercent: z.number().min(1).max(100).default(100),
  isOptional: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
  notes: z.string().max(400).nullish(),
});
export type RecipeLineInput = z.infer<typeof recipeLineInputSchema>;

export const upsertRecipeSchema = scope.extend({
  /** Present = edit that draft. Absent = create. Published recipes are versioned, never mutated. */
  id: uuid.optional(),
  code: z.string().min(1).max(60),
  name: z.string().min(2).max(160),
  kind: z.enum(RECIPE_KINDS).default("menu"),
  status: z.enum(RECIPE_STATUSES).default("draft"),
  categoryId: uuid.nullish(),
  yieldQuantity: z.number().min(0.0001).default(1),
  yieldUnitId: uuid.nullish(),
  producesInventoryItemId: uuid.nullish(),
  instructions: z.string().max(8000).nullish(),
  notes: z.string().max(2000).nullish(),
  targetCost: z.number().min(0).nullish(),
  currency: z.string().min(3).max(3).default("TZS"),
  effectiveFrom: z.string().max(10).nullish(),
  effectiveTo: z.string().max(10).nullish(),
  lines: z.array(recipeLineInputSchema).default([]),
});
export type UpsertRecipeInput = z.infer<typeof upsertRecipeSchema>;

export const recipeIdSchema = z.object({ tenantId: uuid, recipeId: uuid });

/** Creates the next version of a published recipe, copying its components. */
export const versionRecipeSchema = z.object({
  tenantId: uuid,
  recipeId: uuid,
  activate: z.boolean().default(false),
  effectiveFrom: z.string().max(10).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const setRecipeStatusSchema = z.object({
  tenantId: uuid,
  recipeId: uuid,
  status: z.enum(RECIPE_STATUSES),
});

export const computeRecipeCostSchema = z.object({
  tenantId: uuid,
  recipeId: uuid,
  /** Persist a cost-history snapshot as evidence. */
  persist: z.boolean().default(true),
});

/* ---------------- Products ---------------- */

export const listProductsSchema = scope.extend({
  productType: z.enum(PRODUCT_TYPES).optional(),
  activeOnly: z.boolean().default(false),
  search: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(400).default(200),
});

export const upsertProductSchema = scope.extend({
  id: uuid.optional(),
  sku: z.string().min(1).max(60),
  name: z.string().min(2).max(160),
  description: z.string().max(2000).nullish(),
  productType: z.enum(PRODUCT_TYPES).default("standard"),
  categoryId: uuid.nullish(),
  /** Optional by design: bottled drinks and retail lines need no recipe. */
  recipeId: uuid.nullish(),
  menuItemId: uuid.nullish(),
  inventoryItemId: uuid.nullish(),
  stationId: uuid.nullish(),
  price: z.number().min(0).default(0),
  currency: z.string().min(3).max(3).default("TZS"),
  taxRate: z.number().min(0).max(100).default(0),
  taxCode: z.string().max(40).nullish(),
  prepTimeTargetMinutes: z.number().int().min(0).max(600).nullish(),
  servicePeriodIds: z.array(uuid).default([]),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});
export type UpsertProductInput = z.infer<typeof upsertProductSchema>;

export const productIdSchema = z.object({ tenantId: uuid, productId: uuid });

export const upsertVariantSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  productId: uuid,
  sku: z.string().max(60).nullish(),
  name: z.string().min(1).max(120),
  price: z.number().min(0).default(0),
  priceIsDelta: z.boolean().default(false),
  recipeId: uuid.nullish(),
  yieldFactor: z.number().min(0.0001).max(100).default(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const upsertModifierGroupSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  minSelect: z.number().int().min(0).max(20).default(0),
  maxSelect: z.number().int().min(0).max(20).default(1),
  required: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const upsertModifierSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  groupId: uuid,
  name: z.string().min(1).max(120),
  priceDelta: z.number().default(0),
  /** Not every modifier touches stock — "no onions" is price- and prep-only. */
  effect: z.enum(MODIFIER_EFFECTS).default("none"),
  inventoryItemId: uuid.nullish(),
  recipeId: uuid.nullish(),
  quantity: z.number().min(0).default(0),
  unitId: uuid.nullish(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const attachModifierGroupSchema = z.object({
  tenantId: uuid,
  productId: uuid,
  groupId: uuid,
  sortOrder: z.number().int().min(0).default(0),
  attached: z.boolean().default(true),
});

export const upsertBundleComponentSchema = z.object({
  tenantId: uuid,
  bundleProductId: uuid,
  componentProductId: uuid,
  quantity: z.number().min(0.0001).default(1),
  priceAllocation: z.number().min(0).default(0),
  sortOrder: z.number().int().min(0).default(0),
  remove: z.boolean().default(false),
});

export const listModifiersSchema = z.object({ tenantId: uuid });

/* ---------------- Production ---------------- */

export const listProductionsSchema = scope.extend({
  status: z.enum(PRODUCTION_STATUSES).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const startProductionSchema = scope.extend({
  recipeId: uuid,
  batches: z.number().min(0.0001).max(1000).default(1),
  productionLocationId: uuid.nullish(),
  outputLocationId: uuid.nullish(),
  notes: z.string().max(2000).nullish(),
});

export const completeProductionSchema = z.object({
  tenantId: uuid,
  productionId: uuid,
  /** What actually came out. Variance against theoretical yield is evidence, not a verdict. */
  actualQuantity: z.number().min(0),
  inputs: z
    .array(z.object({ inputId: uuid, actualQuantity: z.number().min(0) }))
    .default([]),
  notes: z.string().max(2000).nullish(),
});

export const cancelProductionSchema = z.object({
  tenantId: uuid,
  productionId: uuid,
  reason: z.string().max(400).nullish(),
});

export const productionIdSchema = z.object({ tenantId: uuid, productionId: uuid });

/* ---------------- Read models ---------------- */

export interface RecipeCostLine {
  kind: RecipeComponentKind;
  refId: string | null;
  name: string;
  quantity: number;
  unitCode: string | null;
  yieldPercent: number;
  effectiveQuantity: number;
  unitCost: number;
  lineCost: number;
  unresolved?: boolean;
}

export interface RecipeCostResult {
  recipeId: string;
  recipeCode: string;
  recipeName: string;
  version: number;
  currency: string;
  yieldQuantity: number;
  ingredientCost: number;
  subRecipeCost: number;
  totalCost: number;
  costPerYieldUnit: number;
  targetCost: number | null;
  targetVariance: number | null;
  lines: RecipeCostLine[];
  unresolvedComponents: number;
}

export const recipeStatusTone: Record<RecipeStatus, "success" | "warning" | "neutral" | "danger"> = {
  draft: "warning",
  active: "success",
  inactive: "neutral",
  archived: "neutral",
};

export const productionStatusTone: Record<ProductionStatus, "success" | "warning" | "neutral" | "danger"> = {
  draft: "neutral",
  in_progress: "warning",
  completed: "success",
  cancelled: "danger",
};
