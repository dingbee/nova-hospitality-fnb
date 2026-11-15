import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeRecipeCostSchema, recipeSchema, upsertRecipeComponentSchema } from "../core/contracts";

export const listRestaurantRecipeComponentsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recipeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listRecipeComponents(context.supabase, context.userId, data);
  });

export const upsertRestaurantRecipeComponentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertRecipeComponentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.upsertRecipeComponent(context.supabase, context.userId, data);
  });

export const computeRestaurantRecipeCostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => computeRecipeCostSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.computeRecipeCost(context.supabase, context.userId, data);
  });

export const listRestaurantRecipeCostsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listRecipeCosts(context.supabase, context.userId, data.tenantId);
  });

const activityDriverSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  units: z.number().positive().finite(),
});

export const upsertRestaurantCostActivityDriverFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => activityDriverSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.upsertCostActivityDriver(context.supabase, context.userId, data);
  });

export const listRestaurantCostActivityDriversFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    tenantId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    propertyId: z.string().uuid().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listCostActivityDrivers(context.supabase, context.userId, data);
  });

export const commitRestaurantConsumptionAllocationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    tenantId: z.string().uuid(),
    movementId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    unallocatedReason: z.string().trim().min(3).max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.commitConsumptionAllocation(context.supabase, context.userId, data);
  });


const expenseBase = z.object({ tenantId:z.string().uuid() });
export const listOperationalExpensesFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>expenseBase.parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server"); return mod.listOperationalExpenses(context.supabase,context.userId,data.tenantId);
 });
export const listOperationalExpenseCategoriesFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>expenseBase.parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server"); return mod.listOperationalExpenseCategories(context.supabase,context.userId,data.tenantId);
 });
export const createOperationalExpenseFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({
  tenantId:z.string().uuid(),propertyId:z.string().uuid().nullable().optional(),locationId:z.string().uuid().nullable().optional(),
  categoryId:z.string().uuid(),supplierId:z.string().uuid().nullable().optional(),description:z.string().trim().min(2).max(240),
  amount:z.number().positive().finite(),currency:z.string().regex(/^[A-Z]{3}$/),incurredOn:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
  expenseStatus:z.enum(["draft","recorded"]).default("recorded"),
 }).parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server"); return mod.createOperationalExpense(context.supabase,context.userId,data);
 });
export const approveOperationalExpenseFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.approveOperationalExpense(context.supabase,context.userId,data.tenantId,data.expenseId);});
export const recordOperationalExpensePaymentFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),amount:z.number().positive().finite(),currency:z.string().regex(/^[A-Z]{3}$/),reference:z.string().trim().max(120).optional()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.recordOperationalExpensePayment(context.supabase,context.userId,data);});
export const allocateOperationalExpenseDirectFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.allocateOperationalExpenseDirect(context.supabase,context.userId,data);});

export const createOperationalExpenseCategoryFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),name:z.string().trim().min(2).max(80),categoryKey:z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),parentCategoryId:z.string().uuid().nullable().optional()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.createOperationalExpenseCategory(context.supabase,context.userId,data);});

const allocationRuleValidator = z.object({
  tenantId:z.string().uuid(), name:z.string().trim().min(2).max(100), currency:z.string().regex(/^[A-Z]{3}$/),
  effectiveFrom:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), effectiveTo:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  targets:z.array(z.object({propertyId:z.string().uuid(),locationId:z.string().uuid().nullable().optional(),weight:z.number().positive().finite()})).min(2).max(50),
});
export const listCostAllocationRulesFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>expenseBase.parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server");return mod.listCostAllocationRules(context.supabase,context.userId,data.tenantId);
 });
export const createCostAllocationRuleFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>allocationRuleValidator.parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server");return mod.createCostAllocationRule(context.supabase,context.userId,data);
 });
export const approveCostAllocationRuleFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),ruleId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.approveCostAllocationRule(context.supabase,context.userId,data.tenantId,data.ruleId);});
export const allocateOperationalExpenseByRuleFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),ruleId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.allocateOperationalExpenseByRule(context.supabase,context.userId,data);});

export const updateOperationalExpenseFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({
  tenantId:z.string().uuid(),expenseId:z.string().uuid(),propertyId:z.string().uuid().nullable().optional(),
  locationId:z.string().uuid().nullable().optional(),categoryId:z.string().uuid(),supplierId:z.string().uuid().nullable().optional(),
  description:z.string().trim().min(2).max(240),amount:z.number().positive().finite(),currency:z.string().regex(/^[A-Z]{3}$/),
  incurredOn:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
 }).parse(d)).handler(async({data,context})=>{const mod=await import("./costing.server");return mod.updateOperationalExpense(context.supabase,context.userId,data);});

export const recordOperationalExpenseDraftFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.recordOperationalExpenseDraft(context.supabase,context.userId,data.tenantId,data.expenseId);});

export const rejectOperationalExpenseFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),reason:z.string().trim().min(3).max(500)}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.rejectOperationalExpense(context.supabase,context.userId,data);});

export const cancelOperationalExpenseFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),reason:z.string().trim().min(3).max(500)}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.cancelOperationalExpense(context.supabase,context.userId,data);});

export const listOperationalExpenseSuppliersFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>expenseBase.parse(d)).handler(async({data,context})=>{const mod=await import("./costing.server");return mod.listOperationalExpenseSuppliers(context.supabase,context.userId,data.tenantId);});

export const listRecurringExpenseSchedulesFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>expenseBase.parse(d)).handler(async({data,context})=>{const mod=await import("./costing.server");return mod.listRecurringExpenseSchedules(context.supabase,context.userId,data.tenantId);});

const recurringExpenseSchema=z.object({
 tenantId:z.string().uuid(),propertyId:z.string().uuid().nullable().optional(),locationId:z.string().uuid().nullable().optional(),
 categoryId:z.string().uuid(),supplierId:z.string().uuid().nullable().optional(),description:z.string().trim().min(2).max(240),
 amount:z.number().positive().finite(),currency:z.string().regex(/^[A-Z]{3}$/),cadence:z.enum(["weekly","monthly","quarterly","annually"]),
 nextOccurrence:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),endsOn:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).nullable().optional(),
});
export const createRecurringExpenseScheduleFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>recurringExpenseSchema.parse(d)).handler(async({data,context})=>{const mod=await import("./costing.server");return mod.createRecurringExpenseSchedule(context.supabase,context.userId,data);});
export const updateRecurringExpenseScheduleFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>recurringExpenseSchema.extend({scheduleId:z.string().uuid()}).parse(d)).handler(async({data,context})=>{const mod=await import("./costing.server");return mod.updateRecurringExpenseSchedule(context.supabase,context.userId,data);});
export const setRecurringExpenseScheduleActiveFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),scheduleId:z.string().uuid(),active:z.boolean()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.setRecurringExpenseScheduleActive(context.supabase,context.userId,data);});
export const generateRecurringExpenseOccurrenceFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),scheduleId:z.string().uuid(),occurrenceDate:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/)}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.generateRecurringExpenseOccurrence(context.supabase,context.userId,data);});

export const listOperationalExpenseAuditEventsFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.listOperationalExpenseAuditEvents(context.supabase,context.userId,data.tenantId,data.expenseId);});

export const uploadOperationalExpenseAttachmentFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),fileName:z.string().trim().min(1).max(180),
  mimeType:z.enum(["application/pdf","image/jpeg","image/png","image/webp"]),fileBase64:z.string().min(1).max(14000000)}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.uploadOperationalExpenseAttachment(context.supabase,context.userId,data);});

export const listOperationalExpenseAttachmentsFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.listOperationalExpenseAttachments(context.supabase,context.userId,data.tenantId,data.expenseId);});

export const removeOperationalExpenseAttachmentFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),attachmentId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.removeOperationalExpenseAttachment(context.supabase,context.userId,data);});

export const listOperationalExpenseScheduleAuditEventsFn = createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),scheduleId:z.string().uuid()}).parse(d))
 .handler(async({data,context})=>{const mod=await import("./costing.server");return mod.listOperationalExpenseScheduleAuditEvents(context.supabase,context.userId,data.tenantId,data.scheduleId);});
