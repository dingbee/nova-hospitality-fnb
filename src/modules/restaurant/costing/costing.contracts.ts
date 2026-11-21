import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Server-function input for createOperationalExpenseFn (mirrors costing.server expenseInputSchema). */
export const createOperationalExpenseInputSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(2).max(240),
  amount: z.number().positive().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  incurredOn: isoDate,
  expenseStatus: z.enum(["draft", "recorded"]).default("recorded"),
});

/** Server-function input for createOperationalExpenseCategoryFn. */
export const createOperationalExpenseCategoryInputSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(2).max(80),
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  parentCategoryId: z.string().uuid().nullable().optional(),
});
