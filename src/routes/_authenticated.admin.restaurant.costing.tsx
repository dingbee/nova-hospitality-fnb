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
  approveOperationalExpenseFn, recordOperationalExpensePaymentFn, allocateOperationalExpenseDirectFn,
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