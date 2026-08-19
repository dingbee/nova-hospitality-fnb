/**
 * Bar workspace — tablet-first operational view over the existing
 * location / station / ledger / recipe architecture, beverage lens only.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeftRight, ClipboardList, GlassWater, Timer, Wine } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { getBarSnapshotFn, listBarBeveragesFn, barBeverageVarianceFn } from "../bar.functions";
import type { BarBeverage, BarSnapshot, BarVarianceRow } from "../contracts";
import { PourConfigSheet } from "./PourConfigSheet";

function money(currency: string, n: number | null | undefined) {
  return `${currency} ${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function BarWorkspace({ initialTab }: { initialTab?: string }) {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const currency = ws.data?.properties?.[0]?.currency ?? "TZS";

  const snapshotFn = useServerFn(getBarSnapshotFn);
  const beveragesFn = useServerFn(listBarBeveragesFn);
  const varianceFn = useServerFn(barBeverageVarianceFn);

  const [tab, setTab] = React.useState(initialTab ?? "service");
  const [search, setSearch] = React.useState("");
  const [editing, setEditing] = React.useState<BarBeverage | null>(null);
  const [from] = React.useState(() => new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));

  const snapshot = useQuery({
    queryKey: ["bar.snapshot", tenantId],
    queryFn: () => snapshotFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const beverages = useQuery({
    queryKey: ["bar.beverages", tenantId, search],
    queryFn: () =>
      beveragesFn({ data: { tenantId: tenantId!, search: search || undefined, includeNonBeverage: false, limit: 200 } }),
    enabled: Boolean(tenantId) && (tab === "pours" || tab === "stock"),
  });

  const variance = useQuery({
    queryKey: ["bar.variance", tenantId, from],
    queryFn: () => varianceFn({ data: { tenantId: tenantId!, from, limit: 120 } }),
    enabled: Boolean(tenantId) && tab === "variance",
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const snap = snapshot.data as BarSnapshot | undefined;
  const sales = snap?.sales;
  const rows = (beverages.data ?? []) as BarBeverage[];
  const varianceRows = (variance.data ?? []) as BarVarianceRow[];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bar operations"
        description="Pour configuration, beverage stock, service tickets and theoretical-versus-actual variance — all posted through the same inventory ledger."
      />

      <div className="flex flex-wrap gap-2">
        <Button asChild className="min-h-11">
          <Link to="/admin/restaurant/bar/pos">Open bar tab / Bar POS</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/admin/restaurant/requisitions" search={{ status: undefined }}>
            Request stock
          </Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/admin/restaurant/stock">Record wastage</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/admin/restaurant/inventory-control" search={{ tab: undefined }}>
            Stocktake &amp; receive
          </Link>
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => setTab("variance")}>
          View variance
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/admin/restaurant/intelligence">Bar intelligence</Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open drink tickets" value={String(snap?.openTicketCount ?? 0)} icon={GlassWater} />
        <StatCard
          label="Delayed tickets"
          value={String(snap?.delayedTicketCount ?? 0)}
          icon={Timer}
          tone={(snap?.delayedTicketCount ?? 0) > 0 ? "warn" : "green"}
        />
        <StatCard
          label="Beverage sales (net)"
          value={money(sales?.currency ?? currency, sales?.net)}
          hint={`${sales?.quantity ?? 0} drinks · ${sales?.compCount ?? 0} comped`}
          icon={Wine}
        />
        <StatCard
          label="Pour cost"
          value={sales?.costPercent != null ? `${sales.costPercent.toFixed(1)}%` : "—"}
          hint={`GP ${money(sales?.currency ?? currency, sales?.grossProfit)}`}
          icon={ArrowLeftRight}
          tone={(sales?.costPercent ?? 0) > 30 ? "warn" : "green"}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="service">Service</TabsTrigger>
          <TabsTrigger value="stock">Bar stock</TabsTrigger>
          <TabsTrigger value="pours">Pour setup</TabsTrigger>
          <TabsTrigger value="variance">Variance</TabsTrigger>
        </TabsList>

        <TabsContent value="service" className="space-y-4 pt-4">
          <SectionCard title="Prep board" description="Beverage tickets awaiting the bar, oldest first.">
            {(snap?.tickets ?? []).length === 0 ? (
              <EmptyState title="No open drink tickets" description="Tickets appear here as soon as a drink is sent to the bar." />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(snap?.tickets ?? []).map((t) => (
                  <li key={t.id} className="rounded-xl border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t.ticketNumber ?? "Ticket"}</span>
                      <StatusChip tone={t.isDelayed ? "danger" : t.status === "ready" ? "success" : "info"}>
                        {t.status.replace(/_/g, " ")}
                      </StatusChip>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t.stationName} · waiting {Math.round(t.waitingSeconds / 60)} min
                      {t.targetMinutes ? ` of ${t.targetMinutes} min` : ""}
                    </p>
                    {t.notes ? <p className="mt-1 text-xs text-muted-foreground">{t.notes}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Pending requisitions" description="Bar stock requested from a store.">
              {(snap?.pendingRequisitions ?? []).length === 0 ? (
                <EmptyState title="Nothing pending" description="Raise a requisition to replenish the bar." />
              ) : (
                <ul className="divide-y text-sm">
                  {(snap?.pendingRequisitions ?? []).map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                      <span className="flex items-center gap-2">
                        <ClipboardList className="h-4 w-4 text-muted-foreground" />
                        {r.reference}
                      </span>
                      <StatusChip tone="info">{r.status.replace(/_/g, " ")}</StatusChip>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Low and expiring" description="Replenish before the pour runs out.">
              {(snap?.lowStock ?? []).length === 0 && (snap?.expiring ?? []).length === 0 ? (
                <EmptyState title="Bar stock healthy" description="No items below reorder point or nearing expiry." />
              ) : (
                <ul className="divide-y text-sm">
                  {(snap?.lowStock ?? []).map((l) => (
                    <li key={l.itemId} className="flex items-center justify-between gap-2 py-2">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-[color:var(--os-warn)]" />
                        {l.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {l.onHand} on hand · reorder {l.reorderPoint ?? "—"}
                      </span>
                    </li>
                  ))}
                  {(snap?.expiring ?? []).map((e) => (
                    <li key={e.batchId} className="flex items-center justify-between gap-2 py-2">
                      <span>{e.itemName}</span>
                      <span className="text-xs text-muted-foreground">
                        {e.batchNumber ?? "batch"} · expires {new Date(e.expiryDate).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="stock" className="space-y-4 pt-4">
          <SectionCard title="Beverage stock" description="Pours available are derived from stock on hand and the configured serving.">
            <Input
              className="mb-3 max-w-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search beverages…"
            />
            {rows.length === 0 ? (
              <EmptyState title="No beverages yet" description="Mark inventory items as beverages in pour setup." />
            ) : (
              <ul className="divide-y text-sm">
                {rows.map((b) => (
                  <li key={b.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <span className="font-medium">{b.name}</span>
                      <p className="text-xs text-muted-foreground">
                        {b.onHand} {b.stockUnitCode ?? ""} on hand
                        {b.poursAvailable != null ? ` · ${b.poursAvailable} pours` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {b.pourCost != null ? <span>{money(b.currency, b.pourCost)} / pour</span> : null}
                      {b.low ? <StatusChip tone="warning">low</StatusChip> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="pours" className="space-y-4 pt-4">
          <SectionCard title="Pour setup" description="One serving definition per beverage drives cost, margin and variance.">
            <Input
              className="mb-3 max-w-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search beverages…"
            />
            {rows.length === 0 ? (
              <EmptyState title="Nothing to configure" description="Create inventory items first, then define their pours." />
            ) : (
              <ul className="divide-y text-sm">
                {rows.map((b) => (
                  <li key={b.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <span className="font-medium">{b.name}</span>
                      <p className="text-xs text-muted-foreground">
                        {b.servingSize
                          ? `${b.servingSize} ${b.servingUnitCode ?? ""} per serving · ${b.poursPerStockUnit?.toFixed(1) ?? "—"} pours per ${b.stockUnitCode ?? "unit"}`
                          : "No pour configured"}
                        {b.pourIssue ? ` · ${b.pourIssue}` : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEditing(b)}>
                      Configure pour
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="variance" className="space-y-4 pt-4">
          <SectionCard
            title="Theoretical vs actual"
            description={`Ledger-derived expected closing compared with the latest count, since ${from}.`}
          >
            {varianceRows.length === 0 ? (
              <EmptyState title="No variance data" description="Record sales and a stocktake to reconcile beverage stock." />
            ) : (
              <ul className="divide-y text-sm">
                {varianceRows.map((v) => (
                  <li key={v.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <span className="font-medium">{v.name}</span>
                      <p className="text-xs text-muted-foreground">
                        expected {v.expectedClosing.toFixed(2)} {v.unitCode ?? ""} · actual{" "}
                        {v.actualClosing != null ? v.actualClosing.toFixed(2) : "—"} ({v.actualSource})
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{money(v.currency, v.varianceValue)}</span>
                      <StatusChip tone={Math.abs(v.variancePercent ?? 0) > 5 ? "danger" : "success"}>
                        {v.variancePercent != null ? `${v.variancePercent.toFixed(1)}%` : "—"}
                      </StatusChip>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      {tenantId ? (
        <PourConfigSheet
          tenantId={tenantId}
          beverage={editing}
          open={Boolean(editing)}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      ) : null}
    </div>
  );
}