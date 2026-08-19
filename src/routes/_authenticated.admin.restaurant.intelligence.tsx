/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Brain, ChefHat, Boxes, ShoppingCart, Utensils } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  getRestaurantInventoryIntelligenceFn,
  getRestaurantKitchenIntelligenceFn,
  getRestaurantMenuIntelligenceFn,
  getRestaurantPurchasingIntelligenceFn,
} from "@/modules/restaurant/intelligence/insights.functions";
import { getInventoryMenuOpportunitiesFn } from "@/modules/restaurant/intelligence/inventory-menu.functions";
import {
  MENU_CLASS_LABEL,
  type InsightSeverity,
  type RestaurantInsight,
} from "@/modules/restaurant/intelligence/types";

export const Route = createFileRoute("/_authenticated/admin/restaurant/intelligence")({
  head: () => ({
    meta: [
      { title: "Restaurant Intelligence — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Menu, inventory, kitchen and purchasing intelligence computed from live restaurant operations.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantIntelligencePage,
});

const WINDOWS = [7, 14, 30, 60] as const;

const TONE: Record<InsightSeverity, "neutral" | "success" | "warning" | "danger"> = {
  info: "neutral",
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

function InsightList({ insights }: { insights: RestaurantInsight[] }) {
  if (insights.length === 0) {
    return (
      <EmptyState
        title="Nothing to flag"
        description="Not enough operational data in this window, or everything is within tolerance."
      />
    );
  }
  return (
    <ul className="space-y-3 text-sm">
      {insights.map((i) => (
        <li key={i.key} className="rounded-lg border bg-card/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{i.title}</span>
            <span className="flex items-center gap-2">
              {i.metric ? <span className="text-xs text-muted-foreground">{i.metric}</span> : null}
              <StatusChip tone={TONE[i.severity]}>{i.severity}</StatusChip>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{i.detail}</p>
          {i.recommendation ? (
            <p className="mt-1 text-xs text-foreground/80">→ {i.recommendation}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RestaurantIntelligencePage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const [windowDays, setWindowDays] = useState<number>(30);

  const menuFn = useServerFn(getRestaurantMenuIntelligenceFn);
  const inventoryFn = useServerFn(getRestaurantInventoryIntelligenceFn);
  const kitchenFn = useServerFn(getRestaurantKitchenIntelligenceFn);
  const purchasingFn = useServerFn(getRestaurantPurchasingIntelligenceFn);
  const opportunitiesFn = useServerFn(getInventoryMenuOpportunitiesFn);

  const args = { data: { tenantId: tenantId as string, windowDays } };
  const enabled = Boolean(tenantId);

  const menu = useQuery({
    queryKey: ["restaurant", "intel", "menu", tenantId, windowDays],
    queryFn: () => menuFn(args),
    enabled,
  });
  const inventory = useQuery({
    queryKey: ["restaurant", "intel", "inventory", tenantId, windowDays],
    queryFn: () => inventoryFn(args),
    enabled,
  });
  const kitchen = useQuery({
    queryKey: ["restaurant", "intel", "kitchen", tenantId, windowDays],
    queryFn: () => kitchenFn(args),
    enabled,
  });
  const purchasing = useQuery({
    queryKey: ["restaurant", "intel", "purchasing", tenantId, windowDays],
    queryFn: () => purchasingFn(args),
    enabled,
  });
  const opportunities = useQuery({
    queryKey: ["restaurant", "intel", "opportunities", tenantId, windowDays],
    queryFn: () => opportunitiesFn({ data: { tenantId: tenantId as string, windowDays, targetCoverDays: 7 } }),
    enabled,
  });

  const m = menu.data as any;
  const inv = inventory.data as any;
  const kit = kitchen.data as any;
  const pur = purchasing.data as any;
  const opp = opportunities.data as any;
  const money = (n: number, c = m?.currency ?? "TZS") => `${c} ${Number(n ?? 0).toLocaleString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Restaurant Intelligence"
        description="Advisory only. Every figure is computed from orders, stock movements, tickets and purchase history — nothing is written back."
        actions={
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === windowDays ? "default" : "outline"}
                onClick={() => setWindowDays(w)}
              >
                {w}d
              </Button>
            ))}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Gross profit"
          value={m ? money(m.totals.grossProfit) : "—"}
          hint={m ? `${m.totals.itemsSold} items sold` : undefined}
        />
        <StatCard
          label="Items at stock risk"
          value={inv ? String(inv.atRisk.length) : "—"}
          hint={inv?.wastage.changePercent != null ? `waste ${inv.wastage.changePercent}%` : undefined}
        />
        <StatCard
          label="Avg ticket time"
          value={kit?.averagePrepMinutes != null ? `${kit.averagePrepMinutes} min` : "—"}
          hint={kit?.trendPercent != null ? `${kit.trendPercent > 0 ? "+" : ""}${kit.trendPercent}% vs prior` : undefined}
        />
        <StatCard
          label="Expected monthly spend"
          value={pur ? money(pur.expectedMonthlySpend, pur.currency) : "—"}
          hint={pur?.spendChangePercent != null ? `${pur.spendChangePercent > 0 ? "+" : ""}${pur.spendChangePercent}%` : undefined}
        />
      </div>

      <SectionCard
        title="Menu intelligence"
        description="Profit drivers, margin losers, declining dishes, promotion candidates and recipes needing a cost review."
      >
        <div className="space-y-4">
          <InsightList insights={(m?.insights ?? []) as RestaurantInsight[]} />
          {(m?.items ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(m.items as any[]).slice(0, 15).map((i) => (
                <li key={i.menuItemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <span className="font-medium">{i.name}</span>
                    <p className="text-xs text-muted-foreground">
                      {i.quantitySold} sold · revenue {money(i.revenue)} · GP {money(i.grossProfit)}
                      {i.trendPercent != null ? ` · trend ${i.trendPercent > 0 ? "+" : ""}${i.trendPercent}%` : ""}
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {i.marginPercent != null ? `${i.marginPercent}% margin` : ""}
                    <StatusChip tone={i.classification === "star" ? "success" : i.classification === "dog" ? "danger" : "neutral"}>
                      {MENU_CLASS_LABEL[i.classification as keyof typeof MENU_CLASS_LABEL]}
                    </StatusChip>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No sales in this window"
              description="Close some orders and menu engineering will populate automatically."
              icon={Utensils}
            />
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Inventory intelligence"
        description="Stock runway from consumption velocity, wastage trend and supplier price threats."
      >
        <div className="space-y-4">
          <InsightList insights={(inv?.insights ?? []) as RestaurantInsight[]} />
          {(inv?.atRisk ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(inv.atRisk as any[]).map((r) => (
                <li key={r.inventoryItemId} className="flex items-center justify-between gap-2 py-2">
                  <span>{r.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.currentQuantity} on hand · {r.dailyVelocity}/day ·{" "}
                    {r.daysOfCover != null ? `${r.daysOfCover} days cover` : "no movement"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Stock is comfortable" description="Nothing is forecast to run out soon." icon={Boxes} />
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Kitchen performance intelligence"
        description="Station prep times against targets, dinner-peak pressure and week-on-week movement."
      >
        <div className="space-y-4">
          <InsightList insights={(kit?.insights ?? []) as RestaurantInsight[]} />
          {(kit?.stations ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(kit.stations as any[]).map((s) => (
                <li key={s.stationId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.tickets} tickets ·{" "}
                    {s.averagePrepMinutes != null ? `${s.averagePrepMinutes} min avg` : "no data"}
                    {s.targetMinutes != null ? ` · target ${s.targetMinutes} min` : ""}
                    {s.dinnerPeakMinutes != null ? ` · dinner ${s.dinnerPeakMinutes} min` : ""}
                    {s.delayedPercent != null ? ` · ${s.delayedPercent}% delayed` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No kitchen tickets" description="Fire orders to the kitchen to build this view." icon={ChefHat} />
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Purchasing intelligence"
        description="Recommended purchase quantities from forecast demand, supplier reliability and expected cost impact."
      >
        <div className="space-y-4">
          <InsightList insights={(pur?.insights ?? []) as RestaurantInsight[]} />
          {(pur?.suggestions ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(pur.suggestions as any[]).slice(0, 12).map((s) => (
                <li key={s.inventoryItemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <span className="font-medium">{s.name}</span>
                    <p className="text-xs text-muted-foreground">
                      order {s.recommendedQuantity} · {s.dailyVelocity}/day · {s.leadTimeDays}d lead +{" "}
                      {s.coverDays}d cover
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {money(s.estimatedCost, pur.currency)}
                    {s.supplierName ? ` · ${s.supplierName}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No purchase suggestions" description="Consumption velocity is covered by stock on hand." icon={ShoppingCart} />
          )}
          {(pur?.suppliers ?? []).length > 0 ? (
            <div className="rounded-lg border p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Brain className="size-3.5" /> Supplier reliability ranking
              </p>
              <ul className="divide-y text-sm">
                {(pur.suppliers as any[]).map((s) => (
                  <li key={s.supplierId} className="flex items-center justify-between py-1.5">
                    <span>{s.name}</span>
                    <span className="text-xs text-muted-foreground">
                      score {s.score}/100 · {s.orders} received
                      {s.onTimePercent != null ? ` · ${s.onTimePercent}% on time` : ""}
                      {s.averageLeadTimeDays != null ? ` · ${s.averageLeadTimeDays}d actual lead` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Inventory → menu opportunities"
        description="Findings with evidence. Confidence is derived from measured facts only — advisory, never automatic."
      >
        {((opp?.opportunities ?? []) as any[]).length === 0 ? (
          <EmptyState
            title="No opportunities detected"
            description="Stock cover, expiry and margin are within normal ranges for this window."
            icon={Brain}
          />
        ) : (
          <ul className="divide-y text-sm">
            {(opp.opportunities as any[]).slice(0, 12).map((o) => (
              <li key={o.key} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{o.title}</span>
                  <span className="text-xs text-muted-foreground">
                    priority {o.priority} ·{" "}
                    {o.confidence == null ? "confidence unknown" : `${Math.round(o.confidence * 100)}% confidence`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{o.summary}</p>
                <p className="text-[11px] text-muted-foreground">
                  {(o.evidence as any[]).map((e) => `${e.label}: ${e.value}`).join(" · ")}
                </p>
                {(o.blockers as string[]).length > 0 && (
                  <p className="text-[11px] text-amber-600">Blocked: {(o.blockers as string[]).join(", ")}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}