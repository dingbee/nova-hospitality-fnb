import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { reconcileCost } from "./cost-reconciliation.engine";

type Sb = any;
const periodSchema = z.object({
 tenantId:z.string().uuid(), propertyId:z.string().uuid(),
 periodStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const minor=(v:unknown)=>{const n=Number(v);if(!Number.isFinite(n)||n<0)throw new Error("Invalid source amount");return Math.round(n*100)};
export async function runOperationalAllocationReconciliation(sb:Sb,userId:string,raw:unknown){
 const input=periodSchema.parse(raw);
 if(input.periodEnd<input.periodStart)throw new Error("Period end must not precede period start");
 await assertCapability(sb,userId,input.tenantId,"costing.manage",{propertyId:input.propertyId});
 const {data:expenses,error:expenseError}=await sb.from("restaurant_operational_expenses")
  .select("id,property_id,amount,currency,incurred_on,description,approval_status")
  .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId)
  .gte("incurred_on",input.periodStart).lte("incurred_on",input.periodEnd)
  .eq("approval_status","approved").order("id");
 if(expenseError)throw new Error(expenseError.message);
 const rows=(expenses??[]) as Array<{id:string;amount:string|number;currency:string;incurred_on:string;description:string}>;
 const ids=rows.map(x=>x.id);
 const {data:allocations,error:allocationError}=ids.length?await sb.from("restaurant_cost_allocations")
  .select("source_id,amount,currency").eq("tenant_id",input.tenantId).eq("property_id",input.propertyId)
  .eq("source_type","operational_expense").in("source_id",ids):{data:[],error:null};
 if(allocationError)throw new Error(allocationError.message);
 const allocated=new Map<string,number>();
 for(const a of (allocations??[]) as Array<{source_id:string;amount:string|number;currency:string}>){
  const expense=rows.find(x=>x.id===a.source_id);
  if(!expense||expense.currency!==a.currency)continue;
  allocated.set(a.source_id,(allocated.get(a.source_id)??0)+minor(a.amount));
 }
 const byCurrency=new Map<string,typeof rows>();
 for(const row of rows){if(!/^[A-Z]{3}$/.test(row.currency))throw new Error("Unsupported source currency on expense "+row.id);byCurrency.set(row.currency,[...(byCurrency.get(row.currency)??[]),row]);}
 const results=[];
 for(const [currency,group] of byCurrency){
  const fingerprint=group.map(x=>x.id+":"+String(x.amount)+":"+String(allocated.get(x.id)??0)).join("|");
  const {data:run,error:runError}=await sb.from("restaurant_cost_reconciliation_runs").upsert({
   tenant_id:input.tenantId,property_id:input.propertyId,period_start:input.periodStart,period_end:input.periodEnd,
   currency,source_fingerprint:fingerprint,status:"completed",source_counts:{approved_expenses:group.length,allocation_rows:(allocations??[]).length},
   limitations:["This run verifies approved operating-expense allocation completeness only; it does not infer stock consumption, purchase-price baselines, or unconfigured budgets."],created_by:userId
  },{onConflict:"tenant_id,property_id,period_start,period_end,currency,source_fingerprint",ignoreDuplicates:true}).select("id").maybeSingle();
  if(runError)throw new Error(runError.message);
  let runId=run?.id;
  if(!runId){const found=await sb.from("restaurant_cost_reconciliation_runs").select("id").eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("period_start",input.periodStart).eq("period_end",input.periodEnd).eq("currency",currency).eq("source_fingerprint",fingerprint).single();if(found.error)throw new Error(found.error.message);runId=found.data.id;}
  let varianceCount=0;
  for(const expense of group){
   const expectedMinor=minor(expense.amount),actualMinor=allocated.get(expense.id)??0;
   const variance=reconcileCost({tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency,expectedMinor,actualMinor,sourceType:"operational_expense",sourceId:expense.id,kind:"allocation"});
   if(!variance)continue;
   const {data:line,error:lineError}=await sb.from("restaurant_cost_reconciliation_lines").upsert({
    tenant_id:input.tenantId,run_id:runId,property_id:input.propertyId,source_type:"operational_expense",source_id:expense.id,
    variance_kind:"allocation",currency,expected_amount:expectedMinor/100,actual_amount:actualMinor/100,variance_amount:variance.varianceMinor/100,
    evidence:{description:expense.description,incurred_on:expense.incurred_on,source_amount:expense.amount,allocated_amount:actualMinor/100}
   },{onConflict:"run_id,source_type,source_id,variance_kind",ignoreDuplicates:true}).select("id").maybeSingle();
   if(lineError)throw new Error(lineError.message);
   let lineId=line?.id;
   if(!lineId){const found=await sb.from("restaurant_cost_reconciliation_lines").select("id").eq("run_id",runId).eq("source_type","operational_expense").eq("source_id",expense.id).eq("variance_kind","allocation").single();if(found.error)throw new Error(found.error.message);lineId=found.data.id;}
   const {data:caseRow,error:caseError}=await sb.from("restaurant_cost_variances").upsert({
    tenant_id:input.tenantId,property_id:input.propertyId,reconciliation_line_id:lineId,severity:variance.severity,
   },{onConflict:"reconciliation_line_id",ignoreDuplicates:true}).select("id").maybeSingle();
   if(caseError)throw new Error(caseError.message);
   if(caseRow){await sb.from("restaurant_cost_variance_events").insert({tenant_id:input.tenantId,variance_id:caseRow.id,event_type:"detected",new_status:"detected",note:variance.explanation,actor_id:userId});}
   varianceCount++;
  }
  results.push({runId,currency,sourceCount:group.length,varianceCount});
 }
 return {periodStart:input.periodStart,periodEnd:input.periodEnd,propertyId:input.propertyId,results,scope:"approved_operating_expense_allocation"};
}
export async function listCostReconciliationDashboard(sb:Sb,userId:string,raw:unknown){
 const input=z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid().optional()}).parse(raw);
 await assertTenantRead(sb,userId,input.tenantId,{propertyId:input.propertyId??null});
 let runs=sb.from("restaurant_cost_reconciliation_runs").select("id,property_id,period_start,period_end,currency,status,source_counts,limitations,created_at").eq("tenant_id",input.tenantId).order("created_at",{ascending:false}).limit(50);
 let cases=sb.from("restaurant_cost_variances").select("id,property_id,severity,investigation_status,assigned_to,resolution_details,created_at,updated_at,reconciliation_line_id,restaurant_cost_reconciliation_lines!inner(source_type,source_id,variance_kind,currency,expected_amount,actual_amount,variance_amount,evidence)").eq("tenant_id",input.tenantId).order("created_at",{ascending:false}).limit(200);
 if(input.propertyId){runs=runs.eq("property_id",input.propertyId);cases=cases.eq("property_id",input.propertyId);}
 const [runResult,caseResult]=await Promise.all([runs,cases]);
 if(runResult.error)throw new Error(runResult.error.message);if(caseResult.error)throw new Error(caseResult.error.message);
 return {runs:runResult.data??[],variances:caseResult.data??[]};
}
export async function updateCostVarianceCase(sb:Sb,userId:string,raw:unknown){
 const input=z.object({tenantId:z.string().uuid(),varianceId:z.string().uuid(),status:z.enum(["under_investigation","awaiting_explanation","action_required","resolved","closed","reopened"]),note:z.string().trim().min(3).max(1000).optional(),resolutionDetails:z.string().trim().min(3).max(2000).optional()}).parse(raw);
 await assertCapability(sb,userId,input.tenantId,"costing.manage");
 const {data:before,error:readError}=await sb.from("restaurant_cost_variances").select("id,property_id,investigation_status").eq("tenant_id",input.tenantId).eq("id",input.varianceId).single();
 if(readError)throw new Error(readError.message);
 await assertCapability(sb,userId,input.tenantId,"costing.manage",{propertyId:before.property_id});
 const resolved=input.status==="resolved"||input.status==="closed";
 const {data,error}=await sb.from("restaurant_cost_variances").update({investigation_status:input.status,resolution_details:input.resolutionDetails??null,resolved_at:resolved?new Date().toISOString():null,resolved_by:resolved?userId:null,updated_at:new Date().toISOString()}).eq("tenant_id",input.tenantId).eq("id",input.varianceId).select("id,investigation_status,resolution_details,resolved_at").single();
 if(error)throw new Error(error.message);
 const event=await sb.from("restaurant_cost_variance_events").insert({tenant_id:input.tenantId,variance_id:input.varianceId,event_type:"status_changed",previous_status:before.investigation_status,new_status:input.status,note:input.note??input.resolutionDetails??null,actor_id:userId});
 if(event.error)throw new Error(event.error.message);
 return data;
}
