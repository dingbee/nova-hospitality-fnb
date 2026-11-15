/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import {
  listRestaurantRecipeCostsFn,
  listRestaurantCostActivityDriversFn,
  upsertRestaurantCostActivityDriverFn,
  listOperationalExpensesFn, listOperationalExpenseCategoriesFn, createOperationalExpenseFn,
  approveOperationalExpenseFn, recordOperationalExpensePaymentFn, allocateOperationalExpenseDirectFn, createOperationalExpenseCategoryFn,
  listCostAllocationRulesFn, createCostAllocationRuleFn, approveCostAllocationRuleFn, allocateOperationalExpenseByRuleFn,
} from "@/modules/restaurant/costing/costing.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/costing")({
  head: () => ({
    meta: [
      { title: "Recipe Costing — Restaurant & Bar OS" },
      { name: "description", content: "Ingredient cost, food cost percentage and suggested pricing per menu item." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CostingPage,
});

function CostingPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const fn = useServerFn(listRestaurantRecipeCostsFn);
  const qc = useQueryClient();
  const properties = ws.data?.properties ?? [];
  const [propertyId, setPropertyId] = useState("");
  const [driverKey, setDriverKey] = useState("covers");
  const [periodStart, setPeriodStart] = useState(() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`; });
  const [units, setUnits] = useState("1");
  const effectivePropertyId = propertyId || properties[0]?.id || "";
  const driverListFn = useServerFn(listRestaurantCostActivityDriversFn);
  const driverSaveFn = useServerFn(upsertRestaurantCostActivityDriverFn);
  const drivers = useQuery({
    queryKey: ["restaurant.cost-activity-drivers", tenantId, driverKey, periodStart],
    queryFn: () => driverListFn({ data: { tenantId: tenantId!, driverKey, periodStart } }),
    enabled: Boolean(tenantId && driverKey && periodStart),
  });
  const saveDriver = useAdminMutation({
    mutationFn: () => driverSaveFn({ data: {
      tenantId: tenantId!, propertyId: effectivePropertyId, driverKey,
      periodStart, units: Number(units),
    } }),
    onSuccessToast: () => "Activity driver saved",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.cost-activity-drivers", tenantId] }),
  });
  const expenseListFn = useServerFn(listOperationalExpensesFn);
  const categoryListFn = useServerFn(listOperationalExpenseCategoriesFn);
  const createExpenseFn = useServerFn(createOperationalExpenseFn);
  const approveExpenseFn = useServerFn(approveOperationalExpenseFn);
  const paymentFn = useServerFn(recordOperationalExpensePaymentFn);
  const allocateExpenseFn = useServerFn(allocateOperationalExpenseDirectFn);
  const createCategoryFn = useServerFn(createOperationalExpenseCategoryFn);
  const [newCategoryName,setNewCategoryName] = useState("");
  const [expenseProperty, setExpenseProperty] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("TZS");
  const [incurredOn, setIncurredOn] = useState(() => new Date().toISOString().slice(0,10));
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string,string>>({});
  const categories = useQuery({queryKey:["restaurant.expense-categories",tenantId],queryFn:()=>categoryListFn({data:{tenantId:tenantId!}}),enabled:Boolean(tenantId)});
  const expenses = useQuery({queryKey:["restaurant.operational-expenses",tenantId],queryFn:()=>expenseListFn({data:{tenantId:tenantId!}}),enabled:Boolean(tenantId)});
  const refreshExpenses = () => { void qc.invalidateQueries({queryKey:["restaurant.operational-expenses",tenantId]}); };
  const createCategory = useAdminMutation({mutationFn:()=>createCategoryFn({data:{tenantId:tenantId!,name:newCategoryName,categoryKey:newCategoryName.toLowerCase().trim().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")}}),successMessage:"Expense category created",onSuccess:()=>{setNewCategoryName("");void qc.invalidateQueries({queryKey:["restaurant.expense-categories",tenantId]});}});
  const createExpense = useAdminMutation({mutationFn:()=>createExpenseFn({data:{tenantId:tenantId!,propertyId:expenseProperty||null,categoryId,description,amount:Number(amount),currency,incurredOn}}),successMessage:"Expense recorded",onSuccess:()=>{setDescription("");setAmount("");refreshExpenses();}});
  const approveExpense = useAdminMutation({mutationFn:(expenseId:string)=>approveExpenseFn({data:{tenantId:tenantId!,expenseId}}),successMessage:"Expense approved",onSuccess:refreshExpenses});
  const recordPayment = useAdminMutation({mutationFn:(v:{expenseId:string;amount:number;currency:string})=>paymentFn({data:{tenantId:tenantId!,...v}}),successMessage:"Payment recorded",onSuccess:refreshExpenses});
  const allocateExpense = useAdminMutation({mutationFn:(expenseId:string)=>allocateExpenseFn({data:{tenantId:tenantId!,expenseId}}),successMessage:"Expense allocated",onSuccess:refreshExpenses});
  const q = useQuery({
    queryKey: ["restaurant.recipe-costs", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recipe Costing"
        description="Deterministic costing: Σ (quantity ÷ yield) × average unit cost, plus overhead. No estimates."
      />
      <SectionCard title="Latest costings">
        {(q.data ?? []).length === 0 ? (
          <EmptyState title="Nothing costed yet" description="Add recipe components to a menu item, then compute its cost." />
        ) : (
          <ul className="divide-y text-sm">
            {(q.data ?? []).map((c: any) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <span className="text-muted-foreground">{new Date(c.computed_at).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">
                  cost {c.currency} {Number(c.total_cost).toLocaleString()}
                  {c.food_cost_percent != null ? ` · ${c.food_cost_percent}% food cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Operating expenses" description="Record expenses, route them for independent approval, record payments, and allocate approved property expenses into profitability.">
        <div className="mb-3 flex flex-wrap gap-2"><Input value={newCategoryName} onChange={e=>setNewCategoryName(e.target.value)} placeholder="New category name" aria-label="New expense category"/><Button size="sm" variant="outline" disabled={newCategoryName.trim().length<2||createCategory.isPending} onClick={()=>createCategory.mutate()}>Add category</Button></div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={expenseProperty} onChange={e=>setExpenseProperty(e.target.value)} aria-label="Expense property">
            <option value="">Shared / unassigned</option>{properties.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={categoryId} onChange={e=>setCategoryId(e.target.value)} aria-label="Expense category">
            <option value="">Select category</option>{(categories.data??[]).map((x:any)=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <Input value={description} onChange={e=>setDescription(e.target.value)} placeholder="Expense description" aria-label="Expense description"/>
          <Input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Amount" aria-label="Expense amount"/>
          <Input value={currency} maxLength={3} onChange={e=>setCurrency(e.target.value.toUpperCase())} aria-label="Currency"/>
          <Input type="date" value={incurredOn} onChange={e=>setIncurredOn(e.target.value)} aria-label="Expense date"/>
        </div>
        <div className="mt-3 flex justify-end"><Button size="sm" disabled={!tenantId||!categoryId||description.trim().length<2||Number(amount)<=0||! /^[A-Z]{3}$/.test(currency)||createExpense.isPending} onClick={()=>createExpense.mutate()}>Record expense</Button></div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Expense</th><th>Amount</th><th>Approval</th><th>Payment</th><th>Actions</th></tr></thead>
          <tbody>{(expenses.data??[]).map((e:any)=><tr key={e.id} className="border-b align-top"><td className="py-2"><div className="font-medium">{e.description}</div><div className="text-xs text-muted-foreground">{e.incurred_on} · {properties.find((p:any)=>p.id===e.property_id)?.name??"Shared"}</div></td>
          <td>{e.currency} {Number(e.amount).toLocaleString()}<div className="text-xs text-muted-foreground">Paid {Number(e.paid_amount).toLocaleString()}</div></td>
          <td><span className="capitalize">{e.approval_status}</span></td><td><span className="capitalize">{e.payment_status}</span></td>
          <td><div className="flex flex-wrap gap-1">
            {e.approval_status==="pending"&&<Button size="sm" variant="outline" disabled={approveExpense.isPending} onClick={()=>approveExpense.mutate(e.id)}>Approve</Button>}
            {e.approval_status==="approved"&&e.payment_status!=="paid"&&<><Input className="h-8 w-24" type="number" min="0.01" placeholder="Payment" value={paymentAmounts[e.id]??""} onChange={ev=>setPaymentAmounts(v=>({...v,[e.id]:ev.target.value}))}/><Button size="sm" variant="outline" disabled={recordPayment.isPending||Number(paymentAmounts[e.id])<=0} onClick={()=>recordPayment.mutate({expenseId:e.id,amount:Number(paymentAmounts[e.id]),currency:e.currency})}>Pay</Button></>}
            {e.approval_status==="approved"&&e.property_id&&<Button size="sm" variant="outline" disabled={allocateExpense.isPending} onClick={()=>allocateExpense.mutate(e.id)}>Allocate</Button>}
          </div></td></tr>)}</tbody></table>
          {expenses.isLoading&&<p className="py-3 text-sm text-muted-foreground">Loading expenses…</p>}
          {!expenses.isLoading&&(expenses.data??[]).length===0&&<p className="py-3 text-sm text-muted-foreground">No operational expenses recorded.</p>}
        </div>
      </SectionCard>
      <SectionCard title="Shared expense allocation rules" description="Create weighted, versioned property splits. A second authorized user must approve each draft before it can be applied to an approved expense.">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Input value={ruleName} onChange={e=>setRuleName(e.target.value)} placeholder="Rule name (e.g. Head office)" aria-label="Allocation rule name"/>
          <Input value={ruleCurrency} maxLength={3} onChange={e=>setRuleCurrency(e.target.value.toUpperCase())} aria-label="Rule currency"/>
          <Input type="date" value={ruleEffectiveFrom} onChange={e=>setRuleEffectiveFrom(e.target.value)} aria-label="Rule effective from"/>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={rulePropertyA} onChange={e=>setRulePropertyA(e.target.value)} aria-label="First allocation property"><option value="">First property</option>{properties.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <Input type="number" min="0.01" step="0.01" value={ruleWeightA} onChange={e=>setRuleWeightA(e.target.value)} aria-label="First property weight"/>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={rulePropertyB} onChange={e=>setRulePropertyB(e.target.value)} aria-label="Second allocation property"><option value="">Second property</option>{properties.filter((p:any)=>p.id!==rulePropertyA).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <Input type="number" min="0.01" step="0.01" value={ruleWeightB} onChange={e=>setRuleWeightB(e.target.value)} aria-label="Second property weight"/>
          <Button size="sm" disabled={!tenantId||ruleName.trim().length<2||!rulePropertyA||!rulePropertyB||rulePropertyA===rulePropertyB||Number(ruleWeightA)<=0||Number(ruleWeightB)<=0||! /^[A-Z]{3}$/.test(ruleCurrency)||createRule.isPending} onClick={()=>createRule.mutate()}>Create draft rule</Button>
        </div>
        <ul className="mt-3 divide-y text-sm">
          {(rules.data??[]).map((rule:any)=><li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div><div className="font-medium">{rule.name} · v{rule.version} · {rule.currency}</div><div className="text-xs text-muted-foreground">{rule.targets.map((t:any)=>`${properties.find((p:any)=>p.id===t.property_id)?.name??"Property"} ${Math.round(Number(t.weight)*100)/100}`).join(" / ")} · from {rule.effective_from} · {rule.status}</div></div>
            {rule.status==="draft"&&<Button size="sm" variant="outline" disabled={approveRule.isPending} onClick={()=>approveRule.mutate(rule.id)}>Approve</Button>}
          </li>)}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={Object.keys(expenseRuleSelections)[0]??""} onChange={e=>setExpenseRuleSelections(e.target.value?{[e.target.value]:expenseRuleSelections[e.target.value]??""}:{})} aria-label="Select shared expense">
            <option value="">Select shared approved expense</option>{(expenses.data??[]).filter((e:any)=>!e.property_id&&e.approval_status==="approved").map((e:any)=><option key={e.id} value={e.id}>{e.description} · {e.currency} {Number(e.amount).toLocaleString()}</option>)}
          </select>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={Object.values(expenseRuleSelections)[0]??""} onChange={e=>{const id=Object.keys(expenseRuleSelections)[0];if(id)setExpenseRuleSelections({[id]:e.target.value});}} aria-label="Select approved allocation rule">
            <option value="">Select approved rule</option>{(rules.data??[]).filter((x:any)=>x.status==="approved").map((x:any)=><option key={x.id} value={x.id}>{x.name} · v{x.version}</option>)}
          </select>
          <Button size="sm" disabled={!Object.keys(expenseRuleSelections)[0]||!Object.values(expenseRuleSelections)[0]||allocateByRule.isPending} onClick={()=>{const expenseId=Object.keys(expenseRuleSelections)[0];const ruleId=expenseRuleSelections[expenseId];allocateByRule.mutate({expenseId,ruleId});}}>Allocate shared expense</Button>
        </div>
      </SectionCard>
      <SectionCard title="Hybrid allocation activity drivers" description="Record auditable operating activity by property and period. Shared consumption can use these weighted units when no direct property attribution exists.">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={effectivePropertyId} onChange={(e) => setPropertyId(e.target.value)} aria-label="Driver property">
            <option value="">Select property</option>
            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Input value={driverKey} onChange={(e) => setDriverKey(e.target.value)} placeholder="Driver key (e.g. covers)" aria-label="Driver key" />
          <Input type="month" value={periodStart.slice(0, 7)} onChange={(e) => setPeriodStart(e.target.value ? `${e.target.value}-01` : "")} aria-label="Driver period month" />
          <Input type="number" min="0.0001" step="0.0001" value={units} onChange={(e) => setUnits(e.target.value)} aria-label="Activity units" />
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!effectivePropertyId || !/^[a-z][a-z0-9_]{1,63}$/.test(driverKey) || Number(units) <= 0 || saveDriver.isPending} onClick={() => saveDriver.mutate(undefined)}>Save activity driver</Button>
        </div>
        <ul className="mt-3 divide-y text-sm">
          {(drivers.data ?? []).map((d: any) => <li key={d.id} className="flex items-center justify-between gap-2 py-2"><span>{properties.find((p: any) => p.id === d.property_id)?.name ?? "Property"} · {d.driver_key}</span><span className="text-muted-foreground">{Number(d.units).toLocaleString()} units</span></li>)}
        </ul>
        {drivers.isError && <p className="mt-2 text-sm text-destructive">Could not load activity drivers.</p>}
      </SectionCard>
    </div>
  );
}