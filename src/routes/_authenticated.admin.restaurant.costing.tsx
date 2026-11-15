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
  const [periodStart, setPeriodStart] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
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
    onSuccessToast: "Activity driver saved",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.cost-activity-drivers", tenantId] }),
  });
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

      <SectionCard title="Hybrid allocation activity drivers" description="Record auditable operating activity by property and period. Shared consumption can use these weighted units when no direct property attribution exists.">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={effectivePropertyId} onChange={(e) => setPropertyId(e.target.value)} aria-label="Driver property">
            <option value="">Select property</option>
            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Input value={driverKey} onChange={(e) => setDriverKey(e.target.value)} placeholder="Driver key (e.g. covers)" aria-label="Driver key" />
          <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} aria-label="Driver period start" />
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