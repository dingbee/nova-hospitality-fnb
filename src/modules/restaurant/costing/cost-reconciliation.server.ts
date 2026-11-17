import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { reconcileCost } from "./cost-reconciliation.engine";

type Sb = any;
const periodSchema = z.object({
 tenantId:z.string().uuid(), propertyId:z.string().uuid(),
 periodStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const minor=(v:unknown)=>{const n=Number(v);if(!Number.isFinite(n)||n<0)throw new Error("Invalid source amount");const result=Math.round(n*100);if(!Number.isSafeInteger(result))throw new Error("Source amount exceeds safe minor-unit precision");return result;};
const dayAfter=(date:string)=>{const d=new Date(date+"T00:00:00.000Z");d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
const localMidnightIso=(date:string,timeZone:string)=>{
 const [year,month,day]=date.split("-").map(Number);
 const target=Date.UTC(year,month-1,day,0,0,0);
 let candidate=target;
 const formatter=new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
 for(let attempt=0;attempt<4;attempt++){
  const parts=Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part=>[part.type,part.value]));
  const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
  const delta=target-represented;
  candidate+=delta;
  if(delta===0)break;
 }
 return new Date(candidate).toISOString();
};
const validCurrency=(value:unknown):value is string=>typeof value==="string"&&/^[A-Z]{3}$/.test(value);

async function persistVariance(sb:Sb,userId:string,runId:string,input:{tenantId:string;propertyId:string;periodStart:string;currency:string;sourceType:string;sourceId:string;kind:"allocation"|"purchase_price"|"consumption_cost"|"operating_expense";expectedMinor:number;actualMinor:number;thresholdMinor?:number;evidence:Record<string,unknown>}){
 const variance=reconcileCost({tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency:input.currency,sourceType:input.sourceType,sourceId:input.sourceId,kind:input.kind,expectedMinor:input.expectedMinor,actualMinor:input.actualMinor,thresholdMinor:input.thresholdMinor});
 if(!variance)return false;
 const {data:line,error:lineError}=await sb.from("restaurant_cost_reconciliation_lines").upsert({
  tenant_id:input.tenantId,run_id:runId,property_id:input.propertyId,source_type:input.sourceType,source_id:input.sourceId,
  variance_kind:input.kind,currency:input.currency,expected_amount:input.expectedMinor/100,actual_amount:input.actualMinor/100,
  variance_amount:variance.varianceMinor/100,evidence:input.evidence
 },{onConflict:"run_id,source_type,source_id,variance_kind",ignoreDuplicates:true}).select("id").maybeSingle();
 if(lineError)throw new Error(lineError.message);
 let lineId=line?.id;
 if(!lineId){const found=await sb.from("restaurant_cost_reconciliation_lines").select("id").eq("run_id",runId).eq("source_type",input.sourceType).eq("source_id",input.sourceId).eq("variance_kind",input.kind).single();if(found.error)throw new Error(found.error.message);lineId=found.data.id;}
 const {data:caseRow,error:caseError}=await sb.from("restaurant_cost_variances").upsert({
  tenant_id:input.tenantId,property_id:input.propertyId,reconciliation_line_id:lineId,severity:variance.severity
 },{onConflict:"reconciliation_line_id",ignoreDuplicates:true}).select("id").maybeSingle();
 if(caseError)throw new Error(caseError.message);
 if(caseRow){
  const event=await sb.from("restaurant_cost_variance_events").insert({tenant_id:input.tenantId,variance_id:caseRow.id,event_type:"detected",new_status:"detected",note:variance.explanation,actor_id:userId});
  if(event.error)throw new Error(event.error.message);
  const evidence=await sb.from("restaurant_cost_variance_evidence").insert({tenant_id:input.tenantId,variance_id:caseRow.id,evidence_type:input.sourceType,reference:input.sourceId,description:String(input.evidence.description??input.evidence.label??input.sourceType),created_by:userId});
  if(evidence.error)throw new Error(evidence.error.message);
 }
 return true;
}

export async function runOperationalAllocationReconciliation(sb:Sb,userId:string,raw:unknown){
 const input=periodSchema.parse(raw);
 if(input.periodEnd<input.periodStart)throw new Error("Period end must not precede period start");
 await assertCapability(sb,userId,input.tenantId,"costing.manage",{propertyId:input.propertyId});
 const {data:property,error:propertyError}=await sb.from("restaurant_properties").select("timezone").eq("tenant_id",input.tenantId).eq("id",input.propertyId).single();
 if(propertyError||!property?.timezone)throw new Error("Property timezone is required for calendar-accurate reconciliation.");
 const from=localMidnightIso(input.periodStart,property.timezone),to=localMidnightIso(dayAfter(input.periodEnd),property.timezone);
 const [expenseRes,budgetRes,receiptRes,orderRes]=await Promise.all([
  sb.from("restaurant_operational_expenses").select("id,property_id,category_id,amount,currency,incurred_on,description,approval_status")
   .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).gte("incurred_on",input.periodStart).lte("incurred_on",input.periodEnd).eq("approval_status","approved").order("id"),
  sb.from("restaurant_operational_cost_budgets").select("id,category_id,budget_amount,currency,period_start,period_end")
   .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("period_start",input.periodStart).eq("period_end",input.periodEnd).eq("status","approved"),
  sb.from("restaurant_goods_receipts").select("id,currency,received_at,posted_at,property_id,supplier_id,document_number")
   .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("status","posted").gte("posted_at",from).lt("posted_at",to).order("id"),
  sb.from("restaurant_orders").select("id,currency,closed_at,status")
   .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("status","closed").gte("closed_at",from).lt("closed_at",to).order("id")
 ]);
 for(const r of [expenseRes,budgetRes,receiptRes,orderRes])if(r.error)throw new Error(r.error.message);
 const expenses=(expenseRes.data??[]) as any[],budgets=(budgetRes.data??[]) as any[],receipts=(receiptRes.data??[]) as any[],orders=(orderRes.data??[]) as any[];
 const receiptIds=receipts.map(r=>r.id),orderIds=orders.map(o=>o.id),expenseIds=expenses.map(e=>e.id);
 const [allocationRes,receiptLineRes,orderLineRes]=await Promise.all([
  expenseIds.length?sb.from("restaurant_cost_allocations").select("source_id,amount,currency,period_start").eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("source_type","operational_expense").in("source_id",expenseIds).gte("period_start",input.periodStart).lte("period_start",input.periodEnd):{data:[],error:null},
  receiptIds.length?sb.from("restaurant_goods_receipt_items").select("id,receipt_id,inventory_item_id,unit_id,description,accepted_quantity,ordered_unit_cost,unit_cost,currency").eq("tenant_id",input.tenantId).in("receipt_id",receiptIds):{data:[],error:null},
  orderIds.length?sb.from("restaurant_order_items").select("id,order_id,recipe_id,recipe_version,quantity,theoretical_cost,status,description").eq("tenant_id",input.tenantId).in("order_id",orderIds):{data:[],error:null}
 ]);
 if(allocationRes.error)throw new Error(allocationRes.error.message);
 if(receiptLineRes.error)throw new Error(receiptLineRes.error.message);
 if(orderLineRes.error)throw new Error(orderLineRes.error.message);
 const allocations=(allocationRes.data??[]) as any[],receiptLines=(receiptLineRes.data??[]) as any[],orderLines=((orderLineRes.data??[]) as any[]).filter(l=>l.recipe_id&&l.status!=="voided");
 const receiptById=new Map(receipts.map(r=>[r.id,r]));
 const orderById=new Map(orders.map(o=>[o.id,o]));
 const recipeLineIds=orderLines.map(l=>l.id);
 const recipeIds=[...new Set(orderLines.map(l=>l.recipe_id).filter(Boolean))];
 const recipeCurrencyRes=recipeIds.length?await sb.from("restaurant_recipes").select("id,currency").eq("tenant_id",input.tenantId).in("id",recipeIds):{data:[],error:null};
 if(recipeCurrencyRes.error)throw new Error(recipeCurrencyRes.error.message);
 const recipeCurrencyById=new Map((recipeCurrencyRes.data??[]).map((r:any)=>[r.id,r.currency]));
 const movementRes=recipeLineIds.length?await sb.from("restaurant_stock_movements")
  .select("id,order_item_id,inventory_item_id,quantity,total_cost,currency,unit_id,occurred_at")
  .eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("movement_type","consumption").in("order_item_id",recipeLineIds):{data:[],error:null};
 if(movementRes.error)throw new Error(movementRes.error.message);
 const movements=(movementRes.data??[]) as any[];
 const allocated=new Map<string,number>();
 for(const a of allocations){const expense=expenses.find(e=>e.id===a.source_id);if(!expense||expense.currency!==a.currency)continue;allocated.set(a.source_id,(allocated.get(a.source_id)??0)+minor(a.amount));}
 const receiptVarianceRows=receiptLines.flatMap(line=>{
  const receipt=receiptById.get(line.receipt_id);if(!receipt||!line.unit_id||!validCurrency(line.currency)||line.currency!==receipt.currency||Number(line.accepted_quantity??0)<=0||Number(line.ordered_unit_cost??0)<=0)return [];
  const qty=Number(line.accepted_quantity),expected=minor(qty*Number(line.ordered_unit_cost)),actual=minor(qty*Number(line.unit_cost??0));
  return [{line,receipt,expected,actual}];
 });
 const movementsByOrderLine=new Map<string,any[]>();
 for(const m of movements){const list=movementsByOrderLine.get(m.order_item_id)??[];list.push(m);movementsByOrderLine.set(m.order_item_id,list);}
 const consumptionRows=orderLines.flatMap(line=>{
  const order=orderById.get(line.order_id);if(!order||!validCurrency(order.currency)||recipeCurrencyById.get(line.recipe_id)!==order.currency||Number(line.theoretical_cost??0)<=0)return [];
  const linked=movementsByOrderLine.get(line.id)??[];
  if(linked.some(m=>!validCurrency(m.currency)||m.currency!==order.currency))return [];
  const expected=minor(line.theoretical_cost),actual=linked.reduce((sum,m)=>sum+minor(m.total_cost??0),0);
  return [{line,order,expected,actual,movementCount:linked.length}];
 });
 const currencies=new Set<string>();
 for(const e of expenses)if(validCurrency(e.currency))currencies.add(e.currency);
 for(const b of budgets)if(validCurrency(b.currency))currencies.add(b.currency);
 for(const x of receiptVarianceRows)currencies.add(x.receipt.currency);
 for(const x of consumptionRows)currencies.add(x.order.currency);
 const thresholdsRes=currencies.size?await sb.from("restaurant_cost_variance_thresholds").select("variance_kind,currency,threshold_amount,enabled").eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("enabled",true).in("currency",[...currencies]):{data:[],error:null};
 if(thresholdsRes.error)throw new Error(thresholdsRes.error.message);
 const thresholdMap=new Map<string,number>();
 for(const t of (thresholdsRes.data??[]) as any[])thresholdMap.set(t.variance_kind+":"+t.currency,minor(t.threshold_amount));
 const results=[];
 for(const currency of [...currencies].sort()){
  const expenseGroup=expenses.filter(e=>e.currency===currency),budgetGroup=budgets.filter(b=>b.currency===currency);
  const receiptGroup=receiptVarianceRows.filter(x=>x.receipt.currency===currency),consumptionGroup=consumptionRows.filter(x=>x.order.currency===currency);
  const fingerprint=JSON.stringify({
   expenses:expenseGroup.map(e=>[e.id,e.amount,allocated.get(e.id)??0]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
   budgets:budgetGroup.map(b=>[b.id,b.budget_amount]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
   receipts:receiptGroup.map(x=>[x.line.id,x.expected,x.actual]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
   consumption:consumptionGroup.map(x=>[x.line.id,x.expected,x.actual,x.movementCount]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))
  });
  const sourceCounts={approved_expenses:expenseGroup.length,approved_budgets:budgetGroup.length,posted_receipt_lines:receiptGroup.length,recipe_sales_lines:consumptionGroup.length};
  const {data:run,error:runError}=await sb.from("restaurant_cost_reconciliation_runs").upsert({
   tenant_id:input.tenantId,property_id:input.propertyId,period_start:input.periodStart,period_end:input.periodEnd,currency,source_fingerprint:fingerprint,
   status:"running",source_counts:sourceCounts,limitations:[
    "Operating-expense budget comparisons use only approved budgets matching this exact property, category, period and currency.",
    "Purchase-price comparisons use posted receipts with accepted quantity, a recorded ordered price, identical stock unit and matching currency.",
    "Consumption comparisons use closed recipe-linked order lines with a positive sale-time theoretical-cost snapshot and linked stock consumption movements; currency mismatches are excluded."
   ],created_by:userId
  },{onConflict:"tenant_id,property_id,period_start,period_end,currency,source_fingerprint",ignoreDuplicates:true}).select("id").maybeSingle();
  if(runError)throw new Error(runError.message);
  let runId=run?.id;
  if(!runId){const found=await sb.from("restaurant_cost_reconciliation_runs").select("id").eq("tenant_id",input.tenantId).eq("property_id",input.propertyId).eq("period_start",input.periodStart).eq("period_end",input.periodEnd).eq("currency",currency).eq("source_fingerprint",fingerprint).single();if(found.error)throw new Error(found.error.message);runId=found.data.id;}
  const startUpdate=await sb.from("restaurant_cost_reconciliation_runs").update({status:"running"}).eq("tenant_id",input.tenantId).eq("id",runId);
  if(startUpdate.error)throw new Error(startUpdate.error.message);
  let varianceCount=0;
  try {
  for(const e of expenseGroup){
   const expected=minor(e.amount),actual=allocated.get(e.id)??0;
   const ok=await persistVariance(sb,userId,runId,{tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency,sourceType:"operational_expense",sourceId:e.id,kind:"allocation",expectedMinor:expected,actualMinor:actual,thresholdMinor:thresholdMap.get("allocation:"+currency),evidence:{description:e.description,category_id:e.category_id,incurred_on:e.incurred_on,source_amount:e.amount,allocated_amount:actual/100}});
   if(ok)varianceCount++;
  }
  for(const b of budgetGroup){
   const actual=expenseGroup.filter(e=>e.category_id===b.category_id).reduce((sum,e)=>sum+minor(e.amount),0),expected=minor(b.budget_amount);
   if(actual<=expected)continue;
   const ok=await persistVariance(sb,userId,runId,{tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency,sourceType:"operational_cost_budget",sourceId:b.id,kind:"operating_expense",expectedMinor:expected,actualMinor:actual,thresholdMinor:thresholdMap.get("operating_expense:"+currency),evidence:{description:"Approved category operating budget",category_id:b.category_id,budget_amount:b.budget_amount,actual_expense:actual/100,period_start:b.period_start,period_end:b.period_end}});
   if(ok)varianceCount++;
  }
  for(const x of receiptGroup){
   const ok=await persistVariance(sb,userId,runId,{tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency,sourceType:"goods_receipt_item",sourceId:x.line.id,kind:"purchase_price",expectedMinor:x.expected,actualMinor:x.actual,thresholdMinor:thresholdMap.get("purchase_price:"+currency),evidence:{description:x.line.description,receipt_id:x.receipt.id,receipt_number:x.receipt.document_number,accepted_quantity:x.line.accepted_quantity,unit_id:x.line.unit_id,ordered_unit_cost:x.line.ordered_unit_cost,received_unit_cost:x.line.unit_cost}});
   if(ok)varianceCount++;
  }
  for(const x of consumptionGroup){
   const ok=await persistVariance(sb,userId,runId,{tenantId:input.tenantId,propertyId:input.propertyId,periodStart:input.periodStart,currency,sourceType:"order_item",sourceId:x.line.id,kind:"consumption_cost",expectedMinor:x.expected,actualMinor:x.actual,thresholdMinor:thresholdMap.get("consumption_cost:"+currency),evidence:{description:x.line.description,order_id:x.order.id,recipe_id:x.line.recipe_id,recipe_version:x.line.recipe_version,quantity_sold:x.line.quantity,recipe_cost_snapshot:x.line.theoretical_cost,actual_stock_consumption_cost:x.actual/100,stock_movement_count:x.movementCount}});
   if(ok)varianceCount++;
  }
  const completion=await sb.from("restaurant_cost_reconciliation_runs").update({status:"completed"}).eq("tenant_id",input.tenantId).eq("id",runId);
  if(completion.error)throw new Error(completion.error.message);
  results.push({runId,currency,sourceCount:expenseGroup.length+budgetGroup.length+receiptGroup.length+consumptionGroup.length,varianceCount,sourceCounts});
  } catch(error) {
   await sb.from("restaurant_cost_reconciliation_runs").update({status:"failed"}).eq("tenant_id",input.tenantId).eq("id",runId);
   throw error;
  }
 }
 return {periodStart:input.periodStart,periodEnd:input.periodEnd,propertyId:input.propertyId,results,scope:"approved_expense_allocations_budgets_posted_purchase_receipts_and_recipe_sales_consumption"};
}

export async function listCostReconciliationDashboard(sb:Sb,userId:string,raw:unknown){
 const input=z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid().optional(),periodStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),periodEnd:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(raw);
 await assertTenantRead(sb,userId,input.tenantId,{propertyId:input.propertyId??null});
 let runs=sb.from("restaurant_cost_reconciliation_runs").select("id,property_id,period_start,period_end,currency,status,source_counts,limitations,created_at").eq("tenant_id",input.tenantId).order("created_at",{ascending:false}).limit(50);
 let cases=sb.from("restaurant_cost_variances").select("id,property_id,severity,investigation_status,assigned_to,resolution_details,created_at,updated_at,reconciliation_line_id,restaurant_cost_reconciliation_lines!inner(source_type,source_id,variance_kind,currency,expected_amount,actual_amount,variance_amount,evidence)").eq("tenant_id",input.tenantId).order("created_at",{ascending:false}).limit(200);
 let budgets=sb.from("restaurant_operational_cost_budgets").select("id,category_id,budget_amount,currency,period_start,period_end,status").eq("tenant_id",input.tenantId).eq("status","approved").order("period_start",{ascending:false}).limit(100);
 if(input.propertyId){runs=runs.eq("property_id",input.propertyId);cases=cases.eq("property_id",input.propertyId);budgets=budgets.eq("property_id",input.propertyId);}
 if(input.periodStart&&input.periodEnd)budgets=budgets.eq("period_start",input.periodStart).eq("period_end",input.periodEnd);
 const [runResult,caseResult,budgetResult]=await Promise.all([runs,cases,budgets]);
 if(runResult.error)throw new Error(runResult.error.message);if(caseResult.error)throw new Error(caseResult.error.message);if(budgetResult.error)throw new Error(budgetResult.error.message);
 return {runs:runResult.data??[],variances:caseResult.data??[],budgets:budgetResult.data??[]};
}
export async function saveOperationalCostBudget(sb:Sb,userId:string,raw:unknown){
 const input=z.object({tenantId:z.string().uuid(),propertyId:z.string().uuid(),categoryId:z.string().uuid(),periodStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),periodEnd:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),currency:z.string().regex(/^[A-Z]{3}$/),budgetAmount:z.number().positive().finite()}).parse(raw);
 if(input.periodEnd<input.periodStart)throw new Error("Budget period end must not precede its start");
 await assertCapability(sb,userId,input.tenantId,"costing.manage",{propertyId:input.propertyId});
 const {data:category,error:categoryError}=await sb.from("restaurant_operational_expense_categories").select("id").eq("tenant_id",input.tenantId).eq("id",input.categoryId).single();
 if(categoryError||!category)throw new Error("Expense category is not available in this tenant");
 const now=new Date().toISOString();
 const {data,error}=await sb.from("restaurant_operational_cost_budgets").upsert({
  tenant_id:input.tenantId,property_id:input.propertyId,category_id:input.categoryId,period_start:input.periodStart,period_end:input.periodEnd,
  currency:input.currency,budget_amount:input.budgetAmount,status:"approved",approved_by:userId,approved_at:now,created_by:userId,updated_at:now
 },{onConflict:"tenant_id,property_id,category_id,period_start,period_end,currency"}).select("id,category_id,budget_amount,currency,period_start,period_end,status").single();
 if(error)throw new Error(error.message);
 return data;
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
