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

export const Route = createFileRoute("/_authenticated/admin/restaurant/profitability")({
  head: () => ({
    meta: [
      { title: "Menu Profitability — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Recipe cost versus actual consumption: gross profit, margin and food cost variance per menu item.",
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
  const propertyCurrencies = new Set(properties.map((p: any) => p.currency).filter(Boolean));
  const currency =
    result?.totals.currency ??
    (propertyCurrencies.size === 1 ? [...propertyCurrencies][0] : null);
  const money = (v: number) =>
    currency ? `${currency} ${Number(v).toLocaleString()}` : Number(v).toLocaleString();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Menu profitability"
        description="Recipe → consumption → actual food cost → margin. Theoretical cost comes from recipe costing at the time of sale; actual cost from the stock consumed."
      />

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
            label="Actual food cost"
            value={money(result.totals.actual_cost)}
            icon={Calculator}
          />
          <StatCard
            label="Food cost %"
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
      {result?.dimensions?.length > 0 && (
        <SectionCard title="Channel, outlet and property profitability" description="Contribution and operating profit are shown by source dimension.">
          <ul className="divide-y text-sm">
            {result.dimensions.map((d: any) => (
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
            description="Choose a period and compute to see gross profit and food cost variance per item."
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
                  GP {money(r.gross_profit)}
                  {r.margin_percent != null ? ` · ${r.margin_percent}% margin` : ""}
                  {r.food_cost_percent != null ? ` · ${r.food_cost_percent}% food cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Saved snapshots"
        description="Every computation is stored so trends survive price and recipe changes."
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
                <span>{s.menu_item_name}</span>
                <span className="text-xs text-muted-foreground">
                  {s.period_start} → {s.period_end} · {s.currency}{" "}
                  {Number(s.gross_profit).toLocaleString()} GP
                  {s.food_cost_percent != null ? ` · ${s.food_cost_percent}% food cost` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
