/** Sprint 5.11 — menu lifecycle, availability and allergen contracts. */
import { z } from "zod";
import { MENU_LIFECYCLE_ACTIONS } from "./lifecycle";
import { ALLERGENS } from "./allergens";

const uuid = z.string().uuid();

export const menuBoardSchema = z.object({
  tenantId: uuid,
  menuId: uuid.optional(),
  locationId: uuid.optional(),
  includeArchived: z.boolean().default(false),
  windowDays: z.number().int().min(7).max(120).default(30),
});
export type MenuBoardInput = z.infer<typeof menuBoardSchema>;

export const menuLifecycleSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
  action: z.enum(MENU_LIFECYCLE_ACTIONS),
  reason: z.string().max(300).optional(),
});
export type MenuLifecycleInput = z.infer<typeof menuLifecycleSchema>;

export const menuDeleteSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
  /** Dry run returns the verdict without deleting. */
  confirm: z.boolean().default(false),
});
export type MenuDeleteInput = z.infer<typeof menuDeleteSchema>;

export const setIngredientAllergensSchema = z.object({
  tenantId: uuid,
  inventoryItemId: uuid,
  allergens: z.array(z.enum(ALLERGENS)).default([]),
  status: z.enum(["unknown", "declared", "none"]),
});
export type SetIngredientAllergensInput = z.infer<typeof setIngredientAllergensSchema>;

export const verifyMenuAllergensSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
  allergens: z.array(z.enum(ALLERGENS)).default([]),
  status: z.enum(["declared", "none"]),
});
export type VerifyMenuAllergensInput = z.infer<typeof verifyMenuAllergensSchema>;