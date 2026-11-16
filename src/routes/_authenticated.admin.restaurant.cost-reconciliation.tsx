/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase server-function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { listCostReconciliationDashboardFn,runCostReconciliationFn,updateCostVarianceCaseFn } from "@/modules/restaurant/costing/cost-reconciliation.functions";

export const Route=createFileRoute("/_authenticated/admin/restaurant/cost-reconciliation")({
 head:()=>({meta:[{title:"Cost Reconciliation — LexiBite"},{name:"robots",content:"noindex,nofollow"}]}),
 component:CostReconciliationPage,
});
function CostReconciliationPage(){
 const ws=useRestaurantWorkspace(),tenantId=ws.data?.tenant?.id,properties=ws.data?.properties??[];
 const [propertyId,setPropertyId]=useState(""),[periodStart,setPeriodStart]=useState(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;});
 const [periodEnd,setPeriodEnd]=useState(()=>new Date().toISOString().slice(0,10));
 const effectiveProperty=propertyId||properties[0]?.id||"";
 const qc=useQueryClient(),listFn=useServerFn(listCostReconciliationDashboardFn),runFn=useServerFn(runCostReconciliationFn),caseFn=useServerFn(updateCostVarianceCaseFn);
 const query=useQuery({queryKey:["restaurant.cost-reconciliation",tenantId,effectiveProperty],queryFn:()=>listFn({data:{tenantId:tenantId!,propertyId:effectiveProperty}}),enabled:Boolean(tenantId&&effectiveProperty)});
 const refresh=()=>void qc.invalidateQueries({queryKey:["restaurant.cost-reconciliation",tenantId]});
 const run=useAdminMutation({mutationFn:()=>runFn({data:{tenantId:tenantId!,propertyId:effectiveProperty,periodStart,periodEnd}}),successMessage:"Reconciliation completed",onSuccess:refresh});
 const updateCase=useAdminMutation({mutationFn:(v:{varianceId:string;status:"under_investigation"|"awaiting_explanation"|"action_required"|"resolved"|"closed"|"reopened"})=>caseFn({data:{tenantId:tenantId!,...v,note:"Updated from cost reconciliation workspace"}}),successMessage:"Investigation updated",onSuccess:refresh});
 const variances=query.data?.variances??[],runs=query.data?.runs??[];
 const openCount=variances.filter((v:any)=>!["resolved","closed"].includes(v.investigation_status)).length;
 const criticalCount=variances.filter((v:any)=>v.severity==="critical"||v.severity==="high").length;
 return <div className="space-y-4">
  <PageHeader title="Cost reconciliation" description="Reconcile approved operating expenses against property allocations, investigate variances, and retain an auditable run history."/>
  <SectionCard title="Reconciliation scope" description="This execution currently verifies approved operating-expense allocation completeness. Stock consumption, purchase-price and budget variance sources are explicitly excluded until their baselines are configured and verified.">
   <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <select className="h-9 rounded-md border bg-background px-2 text-sm" value={effectiveProperty} onChange={e=>setPropertyId(e.target.value)} aria-label="Property">
     <option value="">Select property</option>{properties.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    <Input type="date" value={periodStart} onChange={e=>setPeriodStart(e.target.value)} aria-label="Period start"/>
    <Input type="date" value={periodEnd} onChange={e=>setPeriodEnd(e.target.value)} aria-label="Period end"/>
    <Button disabled={!tenantId||!effectiveProperty||periodEnd<periodStart||run.isPending} onClick={()=>run.mutate(undefined)}>{run.isPending?"Reconciling…":"Run reconciliation"}</Button>
   </div>
  </SectionCard>
  <div className="grid gap-3 sm:grid-cols-3">
   <SectionCard title="Reconciliation runs"><div className="text-2xl font-semibold tabular-nums">{runs.length}</div><p className="text-xs text-muted-foreground">Latest 50 runs</p></SectionCard>
   <SectionCard title="Open variances"><div className="text-2xl font-semibold tabular-nums">{openCount}</div><p className="text-xs text-muted-foreground">Require investigation or action</p></SectionCard>
   <SectionCard title="High / critical"><div className="text-2xl font-semibold tabular-nums">{criticalCount}</div><p className="text-xs text-muted-foreground">Elevated severity cases</p></SectionCard>
  </div>
  <SectionCard title="Variance investigations" description="Case status changes are recorded in the event history. Evidence links remain attached to the source reconciliation line.">
   {variances.length===0?<EmptyState title="No variance cases" description="Run a reconciliation for the selected property and period. Balanced expenses do not create variance cases."/>:
    <div className="space-y-3">{variances.map((v:any)=>{const line=v.restaurant_cost_reconciliation_lines??{};return <div key={v.id} className="rounded-lg border p-3 space-y-2">
     <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">{line.variance_kind?.replaceAll("_"," ")??"Cost variance"} · {line.currency} {Number(line.variance_amount??0).toLocaleString()}</div><div className="text-xs text-muted-foreground">{v.severity} · {v.investigation_status.replaceAll("_"," ")}</div></div>
     <div className="text-xs text-muted-foreground">Expected {line.currency} {Number(line.expected_amount??0).toLocaleString()} · Allocated {line.currency} {Number(line.actual_amount??0).toLocaleString()} · Source {line.source_id}</div>
     {v.resolution_details&&<p className="text-sm">{v.resolution_details}</p>}
     <div className="flex flex-wrap gap-2">
      {v.investigation_status==="detected"&&<Button size="sm" variant="outline" onClick={()=>updateCase.mutate({varianceId:v.id,status:"under_investigation"})}>Investigate</Button>}
      {!["resolved","closed"].includes(v.investigation_status)&&<Button size="sm" variant="outline" onClick={()=>updateCase.mutate({varianceId:v.id,status:"resolved"})}>Resolve</Button>}
      {v.investigation_status==="resolved"&&<Button size="sm" variant="outline" onClick={()=>updateCase.mutate({varianceId:v.id,status:"reopened"})}>Reopen</Button>}
      {v.investigation_status==="resolved"&&<Button size="sm" variant="outline" onClick={()=>updateCase.mutate({varianceId:v.id,status:"closed"})}>Close</Button>}
     </div>
    </div>})}</div>}
  </SectionCard>
  <SectionCard title="Run history">
   {runs.length===0?<EmptyState title="No reconciliation history" description="Completed reconciliation runs will appear here."/>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Period</th><th>Currency</th><th>Sources</th><th>Status</th><th>Created</th></tr></thead><tbody>{runs.map((r:any)=><tr key={r.id} className="border-b"><td className="py-2">{r.period_start} – {r.period_end}</td><td>{r.currency}</td><td>{r.source_counts?.approved_expenses??0} approved expenses</td><td className="capitalize">{r.status}</td><td>{new Date(r.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
   {query.isLoading&&<p className="py-2 text-sm text-muted-foreground">Loading reconciliation data…</p>}
   {query.isError&&<p className="py-2 text-sm text-destructive">Unable to load reconciliation data. Check your property access and try again.</p>}
  </SectionCard>
 </div>;
}
