/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Brain, ChefHat, Boxes, ShoppingCart, Sparkles, Utensils } from "lucide-react";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { PRODUCT } from "@/config/product";
import { PageHeader } from "@/components/os/PageHeader";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { IntelligenceModule } from "@/components/os/IntelligenceModule";
import { ReadMore } from "@/components/os/ReadMore";
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
  INSIGHT_SEVERITIES,
  MENU_CLASS_LABEL,
  type InsightSeverity,
  type RestaurantInsight,
} from "@/modules/restaurant/intelligence/types";
import { runMenuIntelligenceReasoningFn } from "@/modules/restaurant/intelligence/menuReasoning.functions";
import { MENU_INTELLIGENCE_STARTER_QUESTIONS } from "@/modules/restaurant/intelligence/menuReasoning.contracts";
import { confidenceBand } from "@/modules/restaurant/intelligence/confidence";

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

const SEVERITY_LABEL: Record<InsightSeverity, string> = {
  info: "Info",
  low: "Low priority",
  medium: "Medium priority",
  high: "High priority",
  critical: "Critical priority",
};

/**
 * The single highest-severity insight in a list — the same
 * INSIGHT_SEVERITIES ordering the engines already use, nothing new
 * computed. Feeds a collapsed module's headline/priority chip so the
 * collapsed summary is never a fabricated "everything's fine" when a
 * real signal exists (spec Part 4/7: collapsed state must communicate
 * what matters now).
 */
function topInsight(insights: RestaurantInsight[]): RestaurantInsight | null {
  if (insights.length === 0) return null;
  return [...insights].sort(
    (a, b) => INSIGHT_SEVERITIES.indexOf(b.severity) - INSIGHT_SEVERITIES.indexOf(a.severity),
  )[0];
}

/** Collapsed-module summary derived from an already-loaded insight list — no new computation, just a headline/priority/meta projection. */
function moduleSummary(insights: RestaurantInsight[], emptyHeadline: string) {
  const top = topInsight(insights);
  return {
    headline: top ? top.title : emptyHeadline,
    priorityLabel: top ? SEVERITY_LABEL[top.severity] : undefined,
    priorityTone: top ? (TONE[top.severity] as StatusTone) : ("neutral" as StatusTone),
    meta:
      insights.length > 0
        ? `${insights.length} active insight${insights.length === 1 ? "" : "s"}`
        : undefined,
  };
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

const PRIORITY_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

/**
 * LexiBite intelligence panel — the model-powered layer of the Menu
 * Intelligence module, presented as LexiBite's own interpretation and
 * recommendation (never a restatement of the deterministic facts above
 * it). The underlying provider/model/latency/prompt version are NEVER
 * rendered here — they remain available server-side in the same
 * evaluation event menuReasoning.server.ts already writes, for
 * engineering observability only (spec Part 1/16). Self-reported
 * confidence is shown as a coarse High/Medium/Low band (confidence.ts),
 * never a bare percentage presented as a statistic (spec Part 9).
 */
function MenuReasoningPanel({
  tenantId,
  windowDays,
}: {
  tenantId: string | undefined;
  windowDays: number;
}) {
  const fn = useServerFn(runMenuIntelligenceReasoningFn);
  const [question, setQuestion] = useState<string>(MENU_INTELLIGENCE_STARTER_QUESTIONS[0]);
  const ask = useAdminMutation({
    mutationFn: (q: string) =>
      fn({ data: { tenantId: tenantId as string, question: q, windowDays, provider: "openai" } }),
    silentSuccess: true,
    // The panel itself renders the degraded/unavailable state below — no duplicate toast.
    silentError: true,
  });

  if (!tenantId) return null;
  const outcome = ask.data;
  const band = outcome && outcome.ok ? confidenceBand(outcome.result.confidence) : null;

  return (
    <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Sparkles className="size-4 text-primary" aria-hidden />
        Ask {PRODUCT.aiName} about this menu
      </div>
      <div className="flex flex-wrap gap-2">
        {MENU_INTELLIGENCE_STARTER_QUESTIONS.map((q) => (
          <Button
            key={q}
            size="sm"
            variant={question === q ? "default" : "outline"}
            disabled={ask.isPending}
            onClick={() => {
              setQuestion(q);
              ask.mutate(q);
            }}
          >
            {q}
          </Button>
        ))}
      </div>

      {ask.isPending && (
        <p className="text-xs text-muted-foreground">
          {PRODUCT.aiName} is reasoning over this window's numbers…
        </p>
      )}

      {outcome && !outcome.ok && (
        <p className="text-xs text-muted-foreground">
          {outcome.reason === "provider_unavailable"
            ? `${PRODUCT.aiName}'s reasoning layer isn't available right now. The deterministic numbers above are unaffected.`
            : outcome.reason === "insufficient_data"
              ? outcome.detail
              : `${PRODUCT.aiName} couldn't produce a reliable answer this time — please try again.`}
        </p>
      )}

      {outcome && outcome.ok && (
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {PRODUCT.aiName}'s interpretation
            </p>
            <ReadMore text={outcome.result.insight} className="mt-0.5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {PRODUCT.aiName} recommendation
            </p>
            <ReadMore text={outcome.result.recommendation} className="mt-0.5" />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <StatusChip tone={PRIORITY_TONE[outcome.result.priority] ?? "neutral"}>
              {outcome.result.priority} priority
            </StatusChip>
            {band && <StatusChip tone="neutral">{band}</StatusChip>}
          </div>
        </div>
      )}
    </div>
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
    queryFn: () =>
      opportunitiesFn({ data: { tenantId: tenantId as string, windowDays, targetCoverDays: 7 } }),
    enabled,
  });

  const m = menu.data as any;
  const inv = inventory.data as any;
  const kit = kitchen.data as any;
  const pur = purchasing.data as any;
  const opp = opportunities.data as any;
  const money = (n: number, c = m?.currency ?? "TZS") => `${c} ${Number(n ?? 0).toLocaleString()}`;

  // Collapsed-module summaries — one projection per domain, computed once.
  // Nothing here is new intelligence: each summary only re-labels the SAME
  // insight list the (unchanged) InsightList below already renders.
  const menuSummary = moduleSummary(
    (m?.insights ?? []) as RestaurantInsight[],
    "Profit drivers, margin losers and promotion candidates for this window",
  );
  const inventorySummary = moduleSummary(
    (inv?.insights ?? []) as RestaurantInsight[],
    "Stock runway, wastage trend and supplier price threats",
  );
  const kitchenSummary = moduleSummary(
    (kit?.insights ?? []) as RestaurantInsight[],
    "Station prep times, dinner-peak pressure and week-on-week movement",
  );
  const purchasingSummary = moduleSummary(
    (pur?.insights ?? []) as RestaurantInsight[],
    "Recommended purchase quantities and supplier reliability",
  );
  const oppList = (opp?.opportunities ?? []) as any[];
  const topOpportunity = oppList[0];
  const opportunitySummary = {
    headline: topOpportunity ? topOpportunity.title : "Nothing crossing a threshold right now",
    priorityLabel: topOpportunity
      ? SEVERITY_LABEL[topOpportunity.priority as InsightSeverity]
      : undefined,
    priorityTone: topOpportunity
      ? ((PRIORITY_TONE[topOpportunity.priority] ?? "neutral") as StatusTone)
      : ("neutral" as StatusTone),
    meta:
      oppList.length > 0
        ? `${oppList.length} opportunit${oppList.length === 1 ? "y" : "ies"}`
        : undefined,
  };

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
          hint={
            inv?.wastage.changePercent != null ? `waste ${inv.wastage.changePercent}%` : undefined
          }
        />
        <StatCard
          label="Avg ticket time"
          value={kit?.averagePrepMinutes != null ? `${kit.averagePrepMinutes} min` : "—"}
          hint={
            kit?.trendPercent != null
              ? `${kit.trendPercent > 0 ? "+" : ""}${kit.trendPercent}% vs prior`
              : undefined
          }
        />
        <StatCard
          label="Expected monthly spend"
          value={pur ? money(pur.expectedMonthlySpend, pur.currency) : "—"}
          hint={
            pur?.spendChangePercent != null
              ? `${pur.spendChangePercent > 0 ? "+" : ""}${pur.spendChangePercent}%`
              : undefined
          }
        />
      </div>

      <IntelligenceModule
        icon={<Utensils className="size-4" />}
        title="Menu intelligence"
        headline={menuSummary.headline}
        priorityLabel={menuSummary.priorityLabel}
        priorityTone={menuSummary.priorityTone}
        meta={menuSummary.meta}
        defaultOpen={menuSummary.priorityTone === "danger"}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Profit drivers, margin losers, declining dishes, promotion candidates and recipes
            needing a cost review.
          </p>
          <InsightList insights={(m?.insights ?? []) as RestaurantInsight[]} />
          {(m?.items ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(m.items as any[]).slice(0, 15).map((i) => (
                <li
                  key={i.menuItemId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{i.name}</span>
                    <p className="text-xs text-muted-foreground">
                      {i.quantitySold} sold · revenue {money(i.revenue)} · GP {money(i.grossProfit)}
                      {i.trendPercent != null
                        ? ` · trend ${i.trendPercent > 0 ? "+" : ""}${i.trendPercent}%`
                        : ""}
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {i.marginPercent != null ? `${i.marginPercent}% margin` : ""}
                    <StatusChip
                      tone={
                        i.classification === "star"
                          ? "success"
                          : i.classification === "dog"
                            ? "danger"
                            : "neutral"
                      }
                    >
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
          <MenuReasoningPanel tenantId={tenantId} windowDays={windowDays} />
        </div>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<Boxes className="size-4" />}
        title="Inventory intelligence"
        headline={inventorySummary.headline}
        priorityLabel={inventorySummary.priorityLabel}
        priorityTone={inventorySummary.priorityTone}
        meta={inventorySummary.meta}
        defaultOpen={inventorySummary.priorityTone === "danger"}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Stock runway from consumption velocity, wastage trend and supplier price threats.
          </p>
          <InsightList insights={(inv?.insights ?? []) as RestaurantInsight[]} />
          {(inv?.atRisk ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(inv.atRisk as any[]).map((r) => (
                <li
                  key={r.inventoryItemId}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <span>{r.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.currentQuantity} on hand · {r.dailyVelocity}/day ·{" "}
                    {r.daysOfCover != null ? `${r.daysOfCover} days cover` : "no movement"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Stock is comfortable"
              description="Nothing is forecast to run out soon."
              icon={Boxes}
            />
          )}
        </div>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<ChefHat className="size-4" />}
        title="Kitchen performance intelligence"
        headline={kitchenSummary.headline}
        priorityLabel={kitchenSummary.priorityLabel}
        priorityTone={kitchenSummary.priorityTone}
        meta={kitchenSummary.meta}
        defaultOpen={kitchenSummary.priorityTone === "danger"}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Station prep times against targets, dinner-peak pressure and week-on-week movement.
          </p>
          <InsightList insights={(kit?.insights ?? []) as RestaurantInsight[]} />
          {(kit?.stations ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(kit.stations as any[]).map((s) => (
                <li
                  key={s.stationId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
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
            <EmptyState
              title="No kitchen tickets"
              description="Fire orders to the kitchen to build this view."
              icon={ChefHat}
            />
          )}
        </div>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<ShoppingCart className="size-4" />}
        title="Purchasing intelligence"
        headline={purchasingSummary.headline}
        priorityLabel={purchasingSummary.priorityLabel}
        priorityTone={purchasingSummary.priorityTone}
        meta={purchasingSummary.meta}
        defaultOpen={purchasingSummary.priorityTone === "danger"}
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Recommended purchase quantities from forecast demand, supplier reliability and expected
            cost impact.
          </p>
          <InsightList insights={(pur?.insights ?? []) as RestaurantInsight[]} />
          {(pur?.suggestions ?? []).length > 0 ? (
            <ul className="divide-y text-sm">
              {(pur.suggestions as any[]).slice(0, 12).map((s) => (
                <li
                  key={s.inventoryItemId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{s.name}</span>
                    <p className="text-xs text-muted-foreground">
                      order {s.recommendedQuantity} · {s.dailyVelocity}/day · {s.leadTimeDays}d lead
                      + {s.coverDays}d cover
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
            <EmptyState
              title="No purchase suggestions"
              description="Consumption velocity is covered by stock on hand."
              icon={ShoppingCart}
            />
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
                      {s.averageLeadTimeDays != null
                        ? ` · ${s.averageLeadTimeDays}d actual lead`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </IntelligenceModule>

      <IntelligenceModule
        icon={<Brain className="size-4" />}
        title="Inventory → menu opportunities"
        headline={opportunitySummary.headline}
        priorityLabel={opportunitySummary.priorityLabel}
        priorityTone={opportunitySummary.priorityTone}
        meta={opportunitySummary.meta}
        defaultOpen={opportunitySummary.priorityTone === "danger"}
      >
        <p className="mb-3 text-xs text-muted-foreground">
          Findings with evidence. Confidence is derived from measured facts only — advisory, never
          automatic.
        </p>
        {oppList.length === 0 ? (
          <EmptyState
            title="No opportunities detected"
            description="Stock cover, expiry and margin are within normal ranges for this window."
            icon={Brain}
          />
        ) : (
          <ul className="divide-y text-sm">
            {oppList.slice(0, 12).map((o) => {
              const band = confidenceBand(o.confidence);
              return (
                <li key={o.key} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{o.title}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusChip tone={(PRIORITY_TONE[o.priority] ?? "neutral") as StatusTone}>
                        {o.priority}
                      </StatusChip>
                      {band ?? "Confidence unknown"}
                    </span>
                  </div>
                  <ReadMore text={o.summary} previewChars={160} className="text-xs" />
                  <p className="text-[11px] text-muted-foreground">
                    {(o.evidence as any[]).map((e) => `${e.label}: ${e.value}`).join(" · ")}
                  </p>
                  {(o.blockers as string[]).length > 0 && (
                    <p className="text-[11px] text-amber-600">
                      Blocked: {(o.blockers as string[]).join(", ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </IntelligenceModule>
    </div>
  );
}
