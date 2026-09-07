/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  Building2,
  Crown,
  LineChart,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { IntelligenceModule } from "@/components/os/IntelligenceModule";
import { Button } from "@/components/ui/button";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { resolveCommercialEntitlementFn } from "@/modules/commercial/commercial.functions";
import {
  getRestaurantAdvancedAnalyticsFn,
  getRestaurantDemandIntelligenceFn,
  getRestaurantExecutiveIntelligenceFn,
  getRestaurantForecastingIntelligenceFn,
  getRestaurantInventoryIntelligenceProFn,
  getRestaurantMultiLocationIntelligenceFn,
  getRestaurantRevenueIntelligenceFn,
} from "@/modules/restaurant/intelligence/p05.functions";
import {
  DATA_SUFFICIENCY_LABEL,
  type DataSufficiency,
} from "@/modules/restaurant/intelligence/sufficiency";
import type { InsightSeverity, RestaurantInsight } from "@/modules/restaurant/intelligence/types";

export const Route = createFileRoute("/_authenticated/admin/restaurant/pro-intelligence")({
  head: () => ({
    meta: [
      { title: "Pro Intelligence — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Demand, forecasting, revenue, advanced analytics, executive and multi-location intelligence for Pro and Enterprise plans.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProIntelligencePage,
});

const WINDOWS = [14, 30, 60, 90] as const;

const TONE: Record<InsightSeverity, "neutral" | "success" | "warning" | "danger"> = {
  info: "neutral",
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

const HEALTH_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  strong: "success",
  stable: "neutral",
  needs_attention: "warning",
  critical: "danger",
};

/** IntelligenceModule's `meta` slot is plain text — this renders the sufficiency label as a string for that slot. */
function sufficiencyMeta(state: DataSufficiency | undefined): string | undefined {
  return state ? `Data: ${DATA_SUFFICIENCY_LABEL[state]}` : undefined;
}

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

/**
 * Wraps a Pro-gated section: shows the upsell card while entitlement is
 * unresolved or the tenant isn't entitled, otherwise renders `children`.
 * Never fetches the real intelligence query until entitlement is confirmed
 * — a Core tenant never even issues the request.
 */
function CapabilityGate({
  entitled,
  loading,
  label,
  children,
}: {
  entitled: boolean;
  loading: boolean;
  label: string;
  children: ReactNode;
}) {
  if (loading) return <p className="text-xs text-muted-foreground">Checking plan entitlement…</p>;
  if (!entitled) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center">
        <Crown className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{label} is a Pro feature</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Upgrade to Pro or Enterprise to unlock this capability. Contact your account owner or
          LexiBite support to change plans.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

function useEntitlement(
  tenantId: string | undefined,
  propertyId: string | undefined,
  code: string,
) {
  const fn = useServerFn(resolveCommercialEntitlementFn);
  const q = useQuery({
    queryKey: ["commercial", "entitlement", tenantId, propertyId, code],
    queryFn: () => fn({ data: { tenantId: tenantId as string, capabilityCode: code, propertyId } }),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
  });
  const entitled = ["included", "limited", "advanced", "enterprise", "add_on"].includes(
    (q.data as any)?.state,
  );
  return { entitled, loading: q.isLoading };
}

function ProIntelligencePage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  // No explicit propertyId is sent from the client — same pattern as the
  // existing Insights page: the server side resolves effective scope
  // (single property, first granted property, or tenant-wide per
  // resolveEffectivePropertyId/resolveMultiPropertyScope) rather than the
  // client guessing which property to default to.
  const propertyId: string | undefined = undefined;
  const [windowDays, setWindowDays] = useState<number>(30);

  const inventoryEnt = useEntitlement(tenantId, propertyId, "inventory_intelligence");
  const demandEnt = useEntitlement(tenantId, propertyId, "demand_intelligence");
  const forecastingEnt = useEntitlement(tenantId, propertyId, "forecasting");
  const revenueEnt = useEntitlement(tenantId, propertyId, "revenue_intelligence");
  const analyticsEnt = useEntitlement(tenantId, propertyId, "advanced_analytics");
  const executiveEnt = useEntitlement(tenantId, propertyId, "executive_intelligence");
  const multiLocationEnt = useEntitlement(tenantId, propertyId, "multi_location_command");

  const args = { data: { tenantId: tenantId as string, windowDays } };
  const enabled = Boolean(tenantId);

  const inventoryFn = useServerFn(getRestaurantInventoryIntelligenceProFn);
  const demandFn = useServerFn(getRestaurantDemandIntelligenceFn);
  const forecastingFn = useServerFn(getRestaurantForecastingIntelligenceFn);
  const revenueFn = useServerFn(getRestaurantRevenueIntelligenceFn);
  const analyticsFn = useServerFn(getRestaurantAdvancedAnalyticsFn);
  const executiveFn = useServerFn(getRestaurantExecutiveIntelligenceFn);
  const multiLocationFn = useServerFn(getRestaurantMultiLocationIntelligenceFn);

  const inventory = useQuery({
    queryKey: ["restaurant", "p05", "inventory", tenantId, windowDays],
    queryFn: () => inventoryFn(args),
    enabled: enabled && inventoryEnt.entitled,
  });
  const demand = useQuery({
    queryKey: ["restaurant", "p05", "demand", tenantId, windowDays],
    queryFn: () => demandFn(args),
    enabled: enabled && demandEnt.entitled,
  });
  const forecasting = useQuery({
    queryKey: ["restaurant", "p05", "forecasting", tenantId, windowDays],
    queryFn: () => forecastingFn({ data: { ...args.data, horizonDays: 14 } }),
    enabled: enabled && forecastingEnt.entitled,
  });
  const revenue = useQuery({
    queryKey: ["restaurant", "p05", "revenue", tenantId, windowDays],
    queryFn: () => revenueFn(args),
    enabled: enabled && revenueEnt.entitled,
  });
  const analytics = useQuery({
    queryKey: ["restaurant", "p05", "analytics", tenantId, windowDays],
    queryFn: () => analyticsFn(args),
    enabled: enabled && analyticsEnt.entitled,
  });
  const executive = useQuery({
    queryKey: ["restaurant", "p05", "executive", tenantId, windowDays],
    queryFn: () => executiveFn(args),
    enabled: enabled && executiveEnt.entitled,
  });
  const multiLocation = useQuery({
    queryKey: ["restaurant", "p05", "multi-location", tenantId, windowDays],
    queryFn: () => multiLocationFn({ data: { tenantId: tenantId as string, windowDays } }),
    enabled: enabled && multiLocationEnt.entitled,
  });

  const inv = inventory.data as any;
  const dem = demand.data as any;
  const fc = forecasting.data as any;
  const rev = revenue.data as any;
  const an = analytics.data as any;
  const ex = executive.data as any;
  const ml = multiLocation.data as any;
  const money = (n: number, c = rev?.currency ?? "TZS") =>
    `${c} ${Number(n ?? 0).toLocaleString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pro Intelligence"
        description="Demand, forecasting, revenue, advanced analytics, executive and multi-location intelligence. Every figure traces to orders, stock movements and purchase history — nothing is invented."
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

      {/* Executive summary — featured, not collapsible. */}
      <CapabilityGate
        entitled={executiveEnt.entitled}
        loading={executiveEnt.loading}
        label="Executive Intelligence"
      >
        {ex ? (
          <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-primary" aria-hidden />
                Executive summary
              </div>
              <StatusChip tone={(HEALTH_TONE[ex.overallHealth] ?? "neutral") as StatusTone}>
                {String(ex.overallHealth).replace(/_/g, " ")}
              </StatusChip>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Revenue"
                value={money(ex.revenue.total, ex.currency)}
                hint={ex.revenue.summary}
              />
              <StatCard
                label="Inventory risk"
                value={String(ex.inventoryRisk.atRiskCount)}
                hint={ex.inventoryRisk.summary}
              />
              <StatCard
                label="Demand outlook"
                value={
                  ex.demandOutlook.orderTrendPercent != null
                    ? `${ex.demandOutlook.orderTrendPercent > 0 ? "+" : ""}${ex.demandOutlook.orderTrendPercent}%`
                    : "—"
                }
                hint={ex.demandOutlook.summary}
              />
              <StatCard
                label="Menu"
                value={`${ex.menuPerformance.starCount} stars`}
                hint={ex.menuPerformance.summary}
              />
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {ex.healthReasons.map((r: string, idx: number) => (
                <li key={idx}>• {r}</li>
              ))}
            </ul>
            {ex.significantAnomalies.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What needs attention
                </p>
                <InsightList insights={ex.significantAnomalies} />
              </div>
            ) : null}
            {ex.priorityRecommendations.length > 0 ? (
              <div>
                <p className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Priority recommendations
                </p>
                <InsightList insights={ex.priorityRecommendations} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading executive summary…</p>
        )}
      </CapabilityGate>

      <IntelligenceModule
        icon={<TrendingUp className="size-4" />}
        title="Demand intelligence"
        headline={dem?.insights?.[0]?.title ?? "Sales volume, day-of-week and item demand patterns"}
        meta={sufficiencyMeta(dem?.sufficiency)}
        defaultOpen
      >
        <CapabilityGate
          entitled={demandEnt.entitled}
          loading={demandEnt.loading}
          label="Demand Intelligence"
        >
          {dem ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard
                  label="Closed orders"
                  value={String(dem.totalOrders)}
                  hint={`${dem.totalCovers} covers`}
                />
                <StatCard
                  label="Order trend"
                  value={
                    dem.orderTrendPercent != null
                      ? `${dem.orderTrendPercent > 0 ? "+" : ""}${dem.orderTrendPercent}%`
                      : "—"
                  }
                  hint="vs prior window"
                />
                <StatCard
                  label="Data sufficiency"
                  value={DATA_SUFFICIENCY_LABEL[dem.sufficiency as DataSufficiency]}
                />
              </div>
              <InsightList insights={dem.insights} />
              {dem.topItems?.length > 0 ? (
                <ul className="divide-y text-sm">
                  {dem.topItems.slice(0, 10).map((i: any) => (
                    <li
                      key={i.menuItemId || i.name}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <span>{i.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {i.quantitySold} sold
                        {i.trendPercent != null
                          ? ` · ${i.trendPercent > 0 ? "+" : ""}${i.trendPercent}%`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<LineChart className="size-4" />}
        title="Forecasting"
        headline="Deterministic sales, revenue and inventory-requirement projections"
        meta={sufficiencyMeta(fc?.salesDemand?.sufficiency)}
      >
        <CapabilityGate
          entitled={forecastingEnt.entitled}
          loading={forecastingEnt.loading}
          label="Forecasting"
        >
          {fc ? (
            <div className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">
                Ordinary least-squares trend over {fc.salesDemand.historicalBasisDays} days of
                history, projected {fc.horizonDays} days forward. Not AI — a straight-line
                continuation of the observed trend.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Sales demand ({fc.horizonDays}d)
                  </p>
                  <p className="text-lg font-semibold">
                    {fc.salesDemand.method === "insufficient_data"
                      ? "Insufficient data"
                      : `${fc.salesDemand.horizonTotal} orders`}
                  </p>
                  {fc.salesDemand.limitations.map((l: string, idx: number) => (
                    <p key={idx} className="text-xs text-muted-foreground">
                      {l}
                    </p>
                  ))}
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Revenue ({fc.horizonDays}d)
                  </p>
                  <p className="text-lg font-semibold">
                    {fc.revenue.method === "insufficient_data"
                      ? "Insufficient data"
                      : money(fc.revenue.horizonTotal, fc.currency)}
                  </p>
                  {fc.revenue.limitations.map((l: string, idx: number) => (
                    <p key={idx} className="text-xs text-muted-foreground">
                      {l}
                    </p>
                  ))}
                </div>
              </div>
              {fc.inventoryRequirement.items.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Forecast-driven inventory requirement
                  </p>
                  <ul className="divide-y">
                    {fc.inventoryRequirement.items.slice(0, 8).map((i: any) => (
                      <li
                        key={i.inventoryItemId}
                        className="flex items-center justify-between py-2"
                      >
                        <span>{i.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {i.recommendedQuantity} units · {money(i.estimatedCost, fc.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <InsightList insights={fc.insights} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<BarChart3 className="size-4" />}
        title="Revenue intelligence"
        headline={
          rev?.insights?.[0]?.title ?? "Revenue trends, item contribution and outlet performance"
        }
        meta={sufficiencyMeta(rev?.sufficiency)}
      >
        <CapabilityGate
          entitled={revenueEnt.entitled}
          loading={revenueEnt.loading}
          label="Revenue Intelligence"
        >
          {rev ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard
                  label="Revenue"
                  value={money(rev.totalRevenue, rev.currency)}
                  hint={
                    rev.revenueTrendPercent != null
                      ? `${rev.revenueTrendPercent > 0 ? "+" : ""}${rev.revenueTrendPercent}%`
                      : undefined
                  }
                />
                <StatCard
                  label="Average order value"
                  value={money(rev.averageOrderValue, rev.currency)}
                />
                <StatCard
                  label="Margin data"
                  value={rev.marginDataAvailable ? "Available" : "Unavailable"}
                />
              </div>
              <InsightList insights={rev.insights} />
              {rev.topContributors?.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Top revenue contributors
                  </p>
                  <ul className="divide-y text-sm">
                    {rev.topContributors.slice(0, 10).map((c: any) => (
                      <li
                        key={c.menuItemId || c.name}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span>{c.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {money(c.revenue, rev.currency)} ({c.revenueSharePercent}%)
                          {c.marginPercent != null ? ` · ${c.marginPercent}% margin` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {rev.byOutlet?.length > 1 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    By outlet
                  </p>
                  <ul className="divide-y text-sm">
                    {rev.byOutlet.map((o: any) => (
                      <li
                        key={o.locationId}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span>{o.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {money(o.revenue, rev.currency)} · {o.orders} orders
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<Activity className="size-4" />}
        title="Advanced analytics"
        headline={
          an?.correlations?.[0]?.title ??
          "Cross-domain correlations across sales, menu, inventory and cost"
        }
      >
        <CapabilityGate
          entitled={analyticsEnt.entitled}
          loading={analyticsEnt.loading}
          label="Advanced Analytics"
        >
          {an ? (
            an.correlations.length === 0 ? (
              <EmptyState
                title="No correlations detected"
                description="Nothing crossed a threshold this window."
              />
            ) : (
              <ul className="space-y-3 text-sm">
                {an.correlations.map((c: any) => (
                  <li key={c.key} className="rounded-lg border bg-card/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{c.title}</span>
                      <StatusChip tone={TONE[c.severity as InsightSeverity]}>
                        {c.severity}
                      </StatusChip>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {c.evidence.map((e: any) => `${e.label}: ${e.value}`).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<Boxes className="size-4" />}
        title="Inventory intelligence — Pro"
        headline={
          inv?.insights?.[0]?.title ??
          "Consumption anomalies and forecast-driven reorder requirements"
        }
        meta={sufficiencyMeta(inv?.sufficiency)}
      >
        <CapabilityGate
          entitled={inventoryEnt.entitled}
          loading={inventoryEnt.loading}
          label="Inventory Intelligence Pro"
        >
          {inv ? (
            <div className="space-y-4">
              <InsightList insights={inv.insights} />
              {inv.anomalies?.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Consumption anomalies
                  </p>
                  <ul className="divide-y text-sm">
                    {inv.anomalies.slice(0, 8).map((a: any) => (
                      <li
                        key={a.inventoryItemId}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span>{a.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {a.currentVelocity}/day vs {a.previousVelocity}/day (
                          {a.changePercent > 0 ? "+" : ""}
                          {a.changePercent}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<Building2 className="size-4" />}
        title="Multi-location command"
        headline={
          ml?.locations?.length
            ? `${ml.locations.length} outlet(s) compared`
            : "Group-level visibility across outlets"
        }
      >
        <CapabilityGate
          entitled={multiLocationEnt.entitled}
          loading={multiLocationEnt.loading}
          label="Multi-Location Command"
        >
          {ml ? (
            ml.locations.length === 0 ? (
              <EmptyState
                title="No outlets to compare"
                description="No accessible locations under your current scope."
              />
            ) : (
              <div className="space-y-4">
                <InsightList insights={ml.insights} />
                <ul className="divide-y text-sm">
                  {ml.locations.map((l: any) => (
                    <li
                      key={l.locationId}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="font-medium">{l.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {money(l.revenue, ml.currency)} · {l.orders} orders ·{" "}
                        {l.atRiskInventoryCount} at risk
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </CapabilityGate>
      </IntelligenceModule>
    </div>
  );
}
