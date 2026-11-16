import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodSchema=z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid(),periodStart:date,periodEnd:date});
export const runCostReconciliationFn=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>periodSchema.parse(d)).handler(async({data,context})=>{
  const mod=await import("./cost-reconciliation.server");
  return mod.runOperationalAllocationReconciliation(context.supabase,context.userId,data);
 });
export const listCostReconciliationDashboardFn=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid().optional(),periodStart:date.optional(),periodEnd:date.optional()}).parse(d)).handler(async({data,context})=>{
  const mod=await import("./cost-reconciliation.server");
  return mod.listCostReconciliationDashboard(context.supabase,context.userId,data);
 });
export const updateCostVarianceCaseFn=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),varianceId:z.string().uuid(),status:z.enum(["under_investigation","awaiting_explanation","action_required","resolved","closed","reopened"]),note:z.string().trim().min(3).max(1000).optional(),resolutionDetails:z.string().trim().min(3).max(2000).optional()}).parse(d)).handler(async({data,context})=>{
  const mod=await import("./cost-reconciliation.server");
  return mod.updateCostVarianceCase(context.supabase,context.userId,data);
 });
export const saveOperationalCostBudgetFn=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid(),categoryId:z.string().uuid(),periodStart:date,periodEnd:date,currency:z.string().regex(/^[A-Z]{3}$/),budgetAmount:z.number().positive().finite()}).parse(d))
 .handler(async({data,context})=>{
  const mod=await import("./cost-reconciliation.server");
  return mod.saveOperationalCostBudget(context.supabase,context.userId,data);
 });
export const listOperationalExpenseCategoriesFn=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>z.object({tenantId:z.string().uuid()}).parse(d)).handler(async({data,context})=>{
  const mod=await import("./costing.server");
  return mod.listOperationalExpenseCategories(context.supabase,context.userId,data.tenantId);
 });
