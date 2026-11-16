/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Calculator, PiggyBank, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  computeRestaurantProfitabilityFn,
  listRestaurantProfitabilityFn,
} from "@/modules/restaurant/costing/profitability.functions";
import {
  listOperationalConsumptionProfilesFn,
  saveOperationalConsumptionProfileFn,
} from "@/modules/restaurant/costing/consumables.functions";
import { listRestaurantInventoryFn } from "@/modules/restaurant/inventory/inventory.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/profitability")({
  head: () => ({
    meta: [
      { title: "Operational Profitability — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Net sales, direct costs, contribution, allocated operating expenses and operating profit by menu item and property.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProfitabilityPage,
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

function ProfitabilityPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();

  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  // ws.data.properties is already scoped server-side to what this caller may
  // access (see getWorkspace) — never a manually-typed/unvalidated id. A
  // single accessible property auto-selects; only a tenant-wide caller with
  // several ever sees the picker.
  const properties = ws.data?.properties ?? [];
  const [propertyId, setPropertyId] = useState<string>("");
  const effectivePropertyId = propertyId || (properties.length === 1 ? properties[0].id : "");

  const listFn = useServerFn(listRestaurantProfitabilityFn);
  const computeFn = useServerFn(computeRestaurantProfitabilityFn);
  const inventoryFn = useServerFn(listRestaurantInventoryFn);
  const listConsumptionProfilesFn = useServerFn(listOperationalConsumptionProfilesFn);
  const saveConsumptionProfileFn = useServerFn(saveOperationalConsumptionProfileFn);
  const [consumableName, setConsumableName] = useState("Guest service supplies");
  const [consumableItemId, setConsumableItemId] = useState("");
  const [consumableCostClass, setConsumableCostClass] = useState<"service_consumable" | "other_direct_variable">("service_consumable");
  const [quantityPerCover, setQuantityPerCover] = useState("1");

  const snapshots = useQuery({
    queryKey: ["restaurant.profitability", tenantId, effectivePropertyId],
    queryFn: () =>
      listFn({
        data: {
          tenantId: tenantId!,
          limit: 100,
          propertyId: effectivePropertyId || undefined,
        },
      }),
    enabled: Boolean(tenantId),
  });
  const inventory = useQuery({
    queryKey: ["restaurant.consumables.inventory", tenantId, effectivePropertyId],
    queryFn: () => inventoryFn({
      data: { tenantId: tenantId!, propertyId: effectivePropertyId, limit: 500, lowOnly: false },
    }),
    enabled: Boolean(tenantId && effectivePropertyId),
  });
  const consumptionProfiles = useQuery({
    queryKey: ["restaurant.consumables.profiles", tenantId, effectivePropertyId],
    queryFn: () => listConsumptionProfilesFn({
      data: { tenantId: tenantId!, propertyId: effectivePropertyId },
    }),
    enabled: Boolean(tenantId && effectivePropertyId),
  });
  const saveConsumable = useAdminMutation({
    mutationFn: () => {
      const item = (inventory.data ?? []).find((row: any) => row.id === consumableItemId);
      if (!item) throw new Error("Select an inventory item before saving.");
      const quantity = Number(quantityPerCover);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity per cover must be greater than zero.");
      return saveConsumptionProfileFn({
        data: {
          tenantId: tenantId!,
          propertyId: effectivePropertyId,
          name: consumableName,
          costClass: consumableCostClass,
          inventoryItemId: consumableItemId,
          unitId: item.unit_id ?? undefined,
          quantityPerCover: quantity,
        },
      });
    },
    onSuccessToast: () => "Operational consumable rule saved",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.consumables.profiles"] });
    },
  });

  const compute = useAdminMutation({
    mutationFn: () =>
      computeFn({
        data: {
          tenantId: tenantId!,
          from: `${from}T00:00:00.000Z`,
          to: `${to}T23:59:59.999Z`,
          persist: true,
          limit: 100,
          propertyId: effectivePropertyId || undefined,
        },
      }),
    onSuccessToast: (d) => `${(d as { rows: unknown[] }).rows.length} menu item(s) analysed`,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.profitability"] }),
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  const result = compute.data;
  const rows = result?.rows ?? [];
  const dimensions = result?.dimensions ?? [];
  const propertyCurrencies = new Set(properties.map((p: any) => p.currency).filter(Boolean));
  const currency =
    result?.totals.currency ??
    (propertyCurrencies.size === 1 ? [...propertyCurrencies][0] : null);
  const money = (v: number) =>
    currency ? `${currency} ${Number(v).toLocaleString()}` : Number(v).toLocaleString();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Operational profitability"
        description="Net sales less recipe COGS and classified service consumables gives contribution; approved operating expense allocations are then deducted to calculate operating profit."
      />

      <SectionCard
        title="Operational consumables"
        description="Configure per-cover stock usage. Each order close consumes the configured quantity once, and the resulting stock movement is classified in profitability."
      >
        {!effectivePropertyId ? (
          <EmptyState title="Select a property" description="Choose a property to configure its operational consumables." />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Profile</span>
                <Input value={consumableName} onChange={(e) => setConsumableName(e.target.value)} placeholder="Guest service supplies" />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Cost classification</span>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={consumableCostClass} onChange={(e) => setConsumableCostClass(e.target.value as "service_consumable" | "other_direct_variable")}>
                  <option value="service_consumable">Service consumable</option>
                  <option value="other_direct_variable">Other direct variable cost</option>
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Inventory item</span>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={consumableItemId} onChange={(e) => setConsumableItemId(e.target.value)}>
                  <option value="">Choose inventory item</option>
                  {(inventory.data ?? []).map((item: any) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Quantity per cover (stock unit)</span>
                <Input type="number" min="0.0001" step="0.0001" value={quantityPerCover} onChange={(e) => setQuantityPerCover(e.target.value)} />
              </div>
            </div>
            <Button size="sm" disabled={saveConsumable.isPending || !consumableItemId || !consumableName.trim()} onClick={() => saveConsumable.mutate(undefined)}>
              Save consumable rule
            </Button>
            {(consumptionProfiles.data ?? []).length > 0 ? (
              <ul className="divide-y text-sm">
                {(consumptionProfiles.data ?? []).map((profile: any) => (
                  <li key={profile.id} className="py-2">
                    <span className="font-medium">{profile.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{profile.cost_class.replaceAll("_", " ")}</span>
                    <ul className="mt-1 space-y-1 pl-3 text-xs text-muted-foreground">
                      {(profile.rules ?? []).map((rule: any) => {
                        const item = (inventory.data ?? []).find((row: any) => row.id === rule.inventory_item_id);
                        return <li key={rule.id}>{item?.name ?? rule.inventory_item_id} · {rule.quantity_per_cover} per cover</li>;
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No operational consumable rules configured for this property.</p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Analysis period" description="Only closed orders are included.">
        <div className="flex flex-wrap items-end gap-2">
          {properties.length > 1 && (
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              aria-label="Property"
            >
              <option value="">All properties</option>
              {properties.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-auto"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-auto"
          />
          <Button size="sm" disabled={compute.isPending} onClick={() => compute.mutate(undefined)}>
            Compute profitability
          </Button>
        </div>
      </SectionCard>

      {result && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Revenue"
            value={money(result.totals.revenue)}
            icon={PiggyBank}
            tone="gold"
          />
          <StatCard
            label="Direct variable cost"
            value={money(result.totals.actual_cost)}
            icon={Calculator}
          />
          <StatCard
            label="Direct cost %"
            value={
              result.totals.food_cost_percent != null ? `${result.totals.food_cost_percent}%` : "—"
            }
            icon={Calculator}
            tone={(result.totals.food_cost_percent ?? 0) > 35 ? "warn" : "green"}
          />
          <StatCard
            label="Cost variance"
            value={money(result.totals.variance)}
            icon={TrendingDown}
            tone={result.totals.variance > 0 ? "danger" : "green"}
            hint="Actual minus theoretical"
          />
          <StatCard
            label="Allocated operating expenses"
            value={money(result.totals.allocated_operating_expenses)}
            icon={Calculator}
            hint="Approved and recognised operating costs"
          />
          <StatCard
            label="Contribution profit"
            value={money(result.totals.contribution_profit)}
            icon={PiggyBank}
            tone={result.totals.contribution_profit < 0 ? "danger" : "green"}
            hint={result.totals.contribution_margin_percent != null ? `${result.totals.contribution_margin_percent}% contribution margin` : "No sales in period"}
          />
          <StatCard
            label="Operating profit"
            value={money(result.totals.operating_profit)}
            icon={Calculator}
            tone={result.totals.operating_profit < 0 ? "danger" : "green"}
            hint={result.totals.operating_margin_percent != null ? `${result.totals.operating_margin_percent}% operating margin` : "No sales in period"}
          />
          <StatCard
            label="Net sales"
            value={money(result.totals.net_sales)}
            icon={PiggyBank}
            hint="After discounts, refunds and tax"
          />
          <StatCard
            label="Service consumables"
            value={money(result.totals.service_consumables)}
            icon={Calculator}
            hint="Awaiting Phase 1 source integration"
          />
        </div>
      )}

      {result && (
        <SectionCard
          title="Operational confidence"
          description={`Calculation status: ${result.operational?.reconciliationState ?? result.totals.confidence_state}. Figures are not certified as fully reconciled while source coverage is incomplete.`}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border p-3 text-sm">
              <p className="text-muted-foreground">Gross sales</p>
              <p className="font-semibold">{money(result.operational?.grossSales ?? result.totals.gross_sales)}</p>
            </div>
            <div className="rounded-md border p-3 text-sm">
              <p className="text-muted-foreground">Refunds</p>
              <p className="font-semibold">{money(result.operational?.refunds ?? result.totals.refunds)}</p>
            </div>
            <div className="rounded-md border p-3 text-sm">
              <p className="text-muted-foreground">Unallocated operating costs</p>
              <p className="font-semibold">{money(result.operational?.unallocatedOperatingExpenses ?? result.totals.unallocated_operating_expenses)}</p>
            </div>
          </div>
        </SectionCard>
      )}
      {result && dimensions.length > 0 && (
        <SectionCard title="Channel, outlet and property profitability" description="Contribution and operating profit are shown by source dimension.">
          <ul className="divide-y text-sm">
            {dimensions.map((d: any) => (
              <li key={`${d.dimension_type}:${d.dimension_key}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div><span className="font-medium">{d.dimension_name}</span><p className="text-xs text-muted-foreground">{d.dimension_type.replace("_", " ")} · net sales {money(d.net_sales)}</p></div>
                <span className="text-xs text-muted-foreground">Contribution {money(d.contribution)} · operating {money(d.operating_profit)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      <SectionCard
        title="By menu item"
        description={rows.length > 0 ? `${rows.length} item(s) in period.` : undefined}
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No analysis yet"
            description="Choose a period and compute to see net sales, direct variable cost and contribution by menu item."
          />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r: any) => (
              <li
                key={r.menu_item_id ?? r.menu_item_name}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <span className="font-medium">{r.menu_item_name}</span>
                  <p className="text-xs text-muted-foreground">
                    {r.quantity_sold} sold · revenue {money(r.revenue)} · cost{" "}
                    {money(r.actual_cost)}
                    {r.variance !== 0 ? ` · variance ${money(r.variance)}` : ""}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  Contribution {money(r.gross_profit)}
                  {r.margin_percent != null ? ` · ${r.margin_percent}% margin` : ""}
                  {r.food_cost_percent != null ? ` · ${r.food_cost_percent}% direct cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Saved snapshots"
        description={effectivePropertyId
          ? "Property-scoped computations are saved with their source references and confidence state."
          : "Select a property to save a scoped snapshot. Tenant-wide comparisons remain view-only to preserve property-level access boundaries."}
      >
        {(snapshots.data ?? []).length === 0 ? (
          <EmptyState
            title="No snapshots"
            description="Computed results are saved here automatically."
          />
        ) : (
          <ul className="divide-y text-sm">
            {(snapshots.data ?? []).slice(0, 25).map((s: any) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span>
                  {s.menu_item_name}
                  {s.confidence_state ? <span className="ml-2 text-xs text-muted-foreground">{s.confidence_state.replaceAll("_", " ")}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {s.period_start} → {s.period_end} · {s.currency}{" "}
                  {Number(s.gross_profit).toLocaleString()} {s.snapshot_type === "operational" ? "operating profit" : "contribution"}
                  {s.food_cost_percent != null ? ` · ${s.food_cost_percent}% direct cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
