/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Reconciliation Centre — "do operations, sales, stock, procurement and money
 * agree for this day?"
 *
 * The screen is deliberately a control surface, not a report: it shows what the
 * system calculated, what staff declared, where the two disagree, and what has
 * to happen before the day can be closed.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Lock, LockOpen, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { money } from "@/modules/restaurant/sales/ui/pos-types";
import {
  closeRestaurantDayFn,
  declareRestaurantTendersFn,
  getRestaurantDailyCloseFn,
  listRestaurantExceptionsFn,
  openRestaurantDailyCloseFn,
  reopenRestaurantDayFn,
  resolveRestaurantExceptionFn,
  restaurantExceptionTrendsFn,
  runRestaurantReconciliationFn,
} from "../reconciliation.functions";
import { CLOSE_STATUS_LABELS, type CloseStatus } from "../contracts";
import { EXCEPTION_CATALOGUE, type ExceptionSeverity } from "../catalogue";

const today = () => new Date().toISOString().slice(0, 10);

const SEVERITY_TONE: Record<ExceptionSeverity, StatusTone> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "info",
};

const STATUS_TONE: Record<CloseStatus, StatusTone> = {
  draft: "neutral",
  declared: "info",
  reconciled: "warning",
  closed: "success",
  reopened: "danger",
};

export function ReconciliationCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id ?? "";
  const currency = (ws.data as any)?.properties?.[0]?.currency ?? "TZS";

  const [businessDate, setBusinessDate] = useState(today);
  const [declared, setDeclared] = useState<Record<string, string>>({});
  const [openingFloat, setOpeningFloat] = useState("0");
  const [overrideReason, setOverrideReason] = useState("");

  const getFn = useServerFn(getRestaurantDailyCloseFn);
  const openFn = useServerFn(openRestaurantDailyCloseFn);
  const declareFn = useServerFn(declareRestaurantTendersFn);
  const runFn = useServerFn(runRestaurantReconciliationFn);
  const closeFn = useServerFn(closeRestaurantDayFn);
  const reopenFn = useServerFn(reopenRestaurantDayFn);
  const trendsFn = useServerFn(restaurantExceptionTrendsFn);

  const day = useQuery({
    queryKey: ["restaurant.close", tenantId, businessDate],
    enabled: Boolean(tenantId),
    queryFn: () => getFn({ data: { tenantId, businessDate } }) as any,
  });

  const trends = useQuery({
    queryKey: ["restaurant.exception.trends", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => trendsFn({ data: { tenantId, days: 30 } }) as any,
  });

  const refresh = () => {
    void day.refetch();
    void trends.refetch();
  };

  const openDay = useAdminMutation({
    mutationFn: () =>
      openFn({ data: { tenantId, businessDate, openingFloat: Number(openingFloat) || 0, currency } }),
    successMessage: "Day opened for closing",
    onSuccess: refresh,
  });

  const declare = useAdminMutation({
    mutationFn: () =>
      declareFn({
        data: {
          tenantId,
          closeId: day.data?.close?.id,
          declarations: Object.entries(declared)
            .filter(([, v]) => v !== "")
            .map(([method, v]) => ({ method, declaredAmount: Number(v) })),
        },
      }),
    successMessage: "Tender declarations recorded",
    onSuccess: refresh,
  });

  const run = useAdminMutation({
    mutationFn: () => runFn({ data: { tenantId, businessDate, scope: "full" as const } }),
    successMessage: "Reconciliation complete",
    onSuccess: refresh,
  });

  const closeDay = useAdminMutation({
    mutationFn: () =>
      closeFn({
        data: {
          tenantId,
          closeId: day.data?.close?.id,
          ...(overrideReason.trim().length >= 10 ? { overrideReason: overrideReason.trim() } : {}),
        },
      }),
    successMessage: "Business date closed",
    onSuccess: () => {
      setOverrideReason("");
      refresh();
    },
  });

  const reopen = useAdminMutation({
    mutationFn: (reason: string) => reopenFn({ data: { tenantId, closeId: day.data?.close?.id, reason } }),
    successMessage: "Business date reopened",
    onSuccess: refresh,
  });

  const view = day.data as any;
  const totals = view?.totals;
  const close = view?.close;
  const tenders = (view?.tenders ?? []) as any[];

  const cashDelta = useMemo(
    () => tenders.reduce((s, t) => s + (t.declaredAmount == null ? 0 : Number(t.variance ?? 0)), 0),
    [tenders],
  );

  if (ws.isLoading) return <LoadingState />;
  if (!tenantId) {
    return <EmptyState title="No restaurant workspace" description="You are not a member of a restaurant tenant yet." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation & Daily Close"
        description="Compare what the system recorded against what was counted, resolve the differences, then close the day."
      />

      <SectionCard title="Business date">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="rec-date">Date</Label>
            <Input id="rec-date" type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
          </div>
          {!close && (
            <div>
              <Label htmlFor="rec-float">Opening float</Label>
              <Input
                id="rec-float"
                inputMode="decimal"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
              />
            </div>
          )}
          {!close ? (
            <Button onClick={() => openDay.mutate(undefined as never)} disabled={openDay.isPending}>
              Open day for closing
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <StatusChip tone={STATUS_TONE[close.status as CloseStatus] ?? "neutral"}>
                {CLOSE_STATUS_LABELS[close.status as CloseStatus] ?? close.status}
              </StatusChip>
              <Button variant="outline" onClick={() => run.mutate(undefined as never)} disabled={run.isPending}>
                <RefreshCw className="mr-1.5 size-4" /> Run reconciliation
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      {day.isLoading || !view ? (
        <LoadingState />
      ) : (
        <Tabs defaultValue="close">
          <TabsList>
            <TabsTrigger value="close">Daily close</TabsTrigger>
            <TabsTrigger value="exceptions">
              Exceptions{view.exceptionSummary.total ? ` (${view.exceptionSummary.total})` : ""}
            </TabsTrigger>
            <TabsTrigger value="patterns">Patterns</TabsTrigger>
          </TabsList>

          <TabsContent value="close" className="space-y-6 pt-4">
            <SectionCard title="What the system recorded" description="Derived from orders, payments and receipts — never edited here.">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure label="Net sales" value={money(totals.netSales, currency)} />
                <Figure label="Payments received" value={money(totals.paymentsReceived, currency)} />
                <Figure
                  label="Outstanding"
                  value={money(totals.outstanding, currency)}
                  tone={Math.abs(totals.outstanding) > 0.01 ? "warning" : "success"}
                />
                <Figure label="Refunds" value={money(totals.refunds, currency)} tone={totals.refunds > 0 ? "warning" : undefined} />
                <Figure label="Gross sales" value={money(totals.grossSales, currency)} />
                <Figure label="Discounts" value={money(totals.discounts, currency)} />
                <Figure label="Service charge" value={money(totals.serviceCharge, currency)} />
                <Figure label="Tax" value={money(totals.tax, currency)} />
                <Figure label="Orders / covers" value={`${totals.orders} / ${totals.covers}`} />
                <Figure label="Receipts issued" value={String(totals.receiptsIssued)} />
                <Figure label="Voided items" value={String(totals.voids)} tone={totals.voids > 0 ? "warning" : undefined} />
                <Figure
                  label="Still open"
                  value={String(totals.openOrders)}
                  tone={totals.openOrders > 0 ? "danger" : "success"}
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Declare what was counted"
              description="Enter the physical count per tender. Cash includes the opening float."
            >
              {!close ? (
                <p className="text-sm text-muted-foreground">Open the day before declaring tenders.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="py-2">Method</th>
                          <th>System</th>
                          <th>Declared</th>
                          <th>Variance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenders.map((t) => (
                          <tr key={t.method} className="border-t border-border">
                            <td className="py-2 capitalize">{t.method.replace(/_/g, " ")}</td>
                            <td>{money(t.systemAmount, currency)}</td>
                            <td className="py-1">
                              <Input
                                aria-label={`Declared ${t.method}`}
                                inputMode="decimal"
                                className="h-9 w-36"
                                placeholder={t.declaredAmount == null ? "Not declared" : ""}
                                value={declared[t.method] ?? (t.declaredAmount == null ? "" : String(t.declaredAmount))}
                                onChange={(e) => setDeclared((d) => ({ ...d, [t.method]: e.target.value }))}
                                disabled={close.status === "closed"}
                              />
                            </td>
                            <td className={Math.abs(t.variance) > 0.01 ? "text-[color:var(--os-warn)]" : ""}>
                              {t.declaredAmount == null ? "—" : money(t.variance, currency)}
                            </td>
                          </tr>
                        ))}
                        {tenders.length === 0 && (
                          <tr>
                            <td colSpan={4} className="py-4 text-center text-muted-foreground">
                              No tenders were taken on this date.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      onClick={() => declare.mutate(undefined as never)}
                      disabled={declare.isPending || close.status === "closed" || tenders.length === 0}
                    >
                      Save declarations
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Net declared variance: {money(cashDelta, currency)}
                    </span>
                  </div>
                </>
              )}
            </SectionCard>

            <SectionCard title="Close control" description="Closing is blocked while the day is not provably in agreement.">
              {view.blockingReasons.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-[color:var(--os-success)]">
                  <CheckCircle2 className="size-4" /> Everything agrees. This day is ready to close.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {view.blockingReasons.map((r: string) => (
                    <li key={r} className="flex items-start gap-2 text-[color:var(--os-warn)]">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {r}
                    </li>
                  ))}
                </ul>
              )}

              {close && close.status !== "closed" && (
                <div className="mt-4 space-y-3">
                  {view.blockingReasons.length > 0 && (
                    <div>
                      <Label htmlFor="rec-override">Override reason (required to close anyway)</Label>
                      <Textarea
                        id="rec-override"
                        rows={2}
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="Explain why the day is being closed with unresolved differences."
                      />
                    </div>
                  )}
                  <Button
                    onClick={() => closeDay.mutate(undefined as never)}
                    disabled={
                      closeDay.isPending ||
                      (view.blockingReasons.length > 0 && overrideReason.trim().length < 10)
                    }
                  >
                    <Lock className="mr-1.5 size-4" /> Close business date
                  </Button>
                </div>
              )}

              {close?.status === "closed" && (
                <ReopenControl pending={reopen.isPending} onReopen={(reason) => reopen.mutate(reason)} />
              )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="exceptions" className="pt-4">
            <ExceptionList tenantId={tenantId} businessDate={businessDate} currency={currency} onChanged={refresh} />
          </TabsContent>

          <TabsContent value="patterns" className="pt-4">
            <SectionCard
              title="Recurring exceptions (30 days)"
              description="A difference that keeps returning is a process problem, not an accident."
            >
              {trends.isLoading || !trends.data ? (
                <LoadingState />
              ) : (trends.data.byCode ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No exceptions were raised in the last 30 days.</p>
              ) : (
                <div className="space-y-2">
                  {trends.data.byCode.map((c: any) => (
                    <div key={c.code} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                      <div className="min-w-0">
                        <div className="font-medium">{EXCEPTION_CATALOGUE[c.code as keyof typeof EXCEPTION_CATALOGUE]?.title ?? c.code}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.count} occurrence(s) across {c.distinctDays} day(s) · {c.open} still open
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {c.recurring && <StatusChip tone="danger">Recurring</StatusChip>}
                        <span className="text-sm">{money(c.impactValue, currency)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: StatusTone }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
        {value}
        {tone && tone !== "success" && <StatusChip tone={tone}>check</StatusChip>}
      </div>
    </div>
  );
}

function ReopenControl({ pending, onReopen }: { pending: boolean; onReopen: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        This date is closed. Reopening rewrites financial evidence after the fact and is recorded against your name.
      </p>
      <div>
        <Label htmlFor="rec-reopen">Reason for reopening</Label>
        <Textarea id="rec-reopen" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button variant="outline" disabled={pending || reason.trim().length < 10} onClick={() => onReopen(reason.trim())}>
        <LockOpen className="mr-1.5 size-4" /> Reopen business date
      </Button>
    </div>
  );
}

function ExceptionList({
  tenantId,
  businessDate,
  currency,
  onChanged,
}: {
  tenantId: string;
  businessDate: string;
  currency: string;
  onChanged: () => void;
}) {
  const listFn = useServerFn(listRestaurantExceptionsFn);
  const resolveFn = useServerFn(resolveRestaurantExceptionFn);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const q = useQuery({
    queryKey: ["restaurant.exceptions", tenantId, businessDate, onlyOpen],
    enabled: Boolean(tenantId),
    queryFn: () => listFn({ data: { tenantId, businessDate, onlyOpen, limit: 200 } }) as any,
  });

  const resolve = useAdminMutation({
    mutationFn: (vars: { exceptionId: string; status: any; resolution?: string }) =>
      resolveFn({ data: { tenantId, note, ...vars } }),
    successMessage: "Exception updated",
    onSuccess: () => {
      setActive(null);
      setNote("");
      void q.refetch();
      onChanged();
    },
  });

  const rows = (q.data?.rows ?? []) as any[];

  return (
    <SectionCard
      title="Exception Centre"
      description="Every unexplained difference, what it means and what has to happen next."
    >
      <div className="mb-4 flex items-center gap-3 text-sm">
        <Button size="sm" variant={onlyOpen ? "default" : "outline"} onClick={() => setOnlyOpen(true)}>
          Open only
        </Button>
        <Button size="sm" variant={onlyOpen ? "outline" : "default"} onClick={() => setOnlyOpen(false)}>
          All
        </Button>
        {q.data?.summary && (
          <span className="text-muted-foreground">
            {q.data.summary.total} open · {money(q.data.summary.impactValue, currency)} at stake
          </span>
        )}
      </div>

      {q.isLoading && <LoadingState />}
      {!q.isLoading && rows.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-[color:var(--os-success)]">
          <CheckCircle2 className="size-4" /> Nothing disagrees for this date.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((e) => (
          <div key={e.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusChip tone={SEVERITY_TONE[e.severity as ExceptionSeverity] ?? "neutral"}>{e.severity}</StatusChip>
                  <StatusChip tone="neutral">{e.domain}</StatusChip>
                  <span className="font-medium">{e.title}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{e.what_happened}</p>
                <p className="mt-1 text-sm">
                  <span className="font-medium">Next: </span>
                  {e.required_action}
                </p>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold">{money(Number(e.impact_value ?? 0), currency)}</div>
                <StatusChip tone={["resolved", "accepted", "dismissed"].includes(e.status) ? "success" : "warning"}>
                  {e.status}
                </StatusChip>
              </div>
            </div>

            {!["resolved", "accepted", "dismissed"].includes(e.status) && (
              <div className="mt-3">
                {active === e.id ? (
                  <div className="space-y-2">
                    <Label htmlFor={`note-${e.id}`}>What did you find? (recorded permanently)</Label>
                    <Textarea id={`note-${e.id}`} rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={note.trim().length < 5 || resolve.isPending}
                        onClick={() => resolve.mutate({ exceptionId: e.id, status: "resolved", resolution: "corrected" })}
                      >
                        Resolved
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={note.trim().length < 5 || resolve.isPending}
                        onClick={() => resolve.mutate({ exceptionId: e.id, status: "accepted", resolution: "accepted" })}
                      >
                        Accept difference
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={note.trim().length < 5 || resolve.isPending}
                        onClick={() => resolve.mutate({ exceptionId: e.id, status: "dismissed", resolution: "not an issue" })}
                      >
                        Dismiss
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setActive(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => { setActive(e.id); setNote(""); }}>
                    Investigate
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}