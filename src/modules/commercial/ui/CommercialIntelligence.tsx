/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * P04 — Commercial Intelligence & Automation: the executive intelligence
 * layer over P01 (policy)/P02 (transactions)/P03 (operations). Lives inside
 * the existing Commercial Centre as one additional tab — it never replaces
 * Commercial Overview, Customers, Renewals or Collections, and every number
 * here is a server-computed projection of the same authoritative records
 * those tabs already read (see intelligence.server.ts's module header).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  AlertTriangle,
  Building2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  completeCommercialRecommendationFn,
  dismissCommercialRecommendationFn,
  getCommercialForecastFn,
  getCommercialIntelligenceOverviewFn,
  listCommercialCustomerIntelligenceFn,
  listCommercialRecommendationsFn,
  listCommercialSignalsFn,
  runCommercialSignalScanFn,
} from "../commercial.functions";

const TZS = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Number(n)) + " TZS";

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: "border-emerald-400 text-emerald-700 dark:text-emerald-400",
  WATCH: "border-amber-400 text-amber-700 dark:text-amber-400",
  AT_RISK: "border-orange-500 text-orange-700 dark:text-orange-400",
  CRITICAL: "border-red-500 text-red-700 dark:text-red-400",
};

const SEVERITY_TONE: Record<string, string> = {
  info: "",
  low: "border-amber-300 text-amber-700 dark:text-amber-400",
  medium: "border-amber-400 text-amber-700 dark:text-amber-400",
  high: "border-orange-500 text-orange-700 dark:text-orange-400",
  critical: "border-red-500 text-red-700 dark:text-red-400",
};

function healthBadge(band: string) {
  return (
    <Badge variant="outline" className={HEALTH_TONE[band] ?? ""}>
      {band}
    </Badge>
  );
}

function severityBadge(severity: string) {
  return (
    <Badge variant="outline" className={SEVERITY_TONE[severity] ?? ""}>
      {severity}
    </Badge>
  );
}

/* ============================================================== Overview */

export function IntelligenceOverviewPanel() {
  const getOverview = useServerFn(getCommercialIntelligenceOverviewFn);
  const getForecast = useServerFn(getCommercialForecastFn);

  const overview = useQuery({
    queryKey: ["commercial.intelligence.overview"],
    queryFn: () => getOverview({ data: {} }),
  });
  const forecast = useQuery({
    queryKey: ["commercial.intelligence.forecast"],
    queryFn: () => getForecast({ data: {} }),
  });

  if (overview.isLoading || forecast.isLoading) return <LoadingState />;
  const o = overview.data;
  const f = forecast.data;
  if (!o || !f) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="MRR"
          value={TZS(o.mrr)}
          icon={Wallet}
          hint="active/trial/past_due/renewing"
        />
        <StatCard label="ARR" value={TZS(o.arr)} icon={TrendingUp} />
        <StatCard
          label="Active customers"
          value={o.activeCustomers}
          icon={Building2}
          hint={`${o.portfolioSize} in portfolio`}
        />
        <StatCard label="Active subscriptions" value={o.activeSubscriptions} icon={Activity} />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Renewals — next 30 days"
          value={o.renewalExposure30}
          icon={AlertTriangle}
        />
        <StatCard label="Overdue exposure" value={TZS(o.overdueExposure)} icon={TrendingDown} />
        <StatCard
          label="At-risk revenue"
          value={TZS(o.atRiskRevenue)}
          icon={ShieldAlert}
          hint="MRR of AT_RISK/CRITICAL customers"
        />
        <StatCard
          label="Expansion opportunity"
          value={TZS(o.expansionOpportunity)}
          icon={Sparkles}
          hint="unbilled chargeable properties"
        />
      </div>

      <SectionCard
        title="Customer health distribution"
        description="Deterministic, rule-based classification — see the Customers panel for per-customer reasons."
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {(["HEALTHY", "WATCH", "AT_RISK", "CRITICAL"] as const).map((band) => (
            <StatCard key={band} label={band} value={o.healthDistribution[band]} />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Commercial forecast"
        description="Deterministic calculations from recorded data, not machine-learning predictions. Assumptions are stated explicitly below."
      >
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <dt className="text-muted-foreground">Renewal-adjusted forecast</dt>
          <dd className="text-right font-medium md:col-span-2">{TZS(f.renewalAdjustedForecast)}</dd>
          <dt className="text-muted-foreground">At-risk recurring revenue</dt>
          <dd className="text-right font-medium md:col-span-2">{TZS(f.atRiskRecurringRevenue)}</dd>
        </dl>
        <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
          {f.assumptions.map((a: string, i: number) => (
            <li key={i}>• {a}</li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

/* ========================================================= Customer health */

export function CustomerHealthPanel() {
  const listIntel = useServerFn(listCommercialCustomerIntelligenceFn);
  const rows = useQuery({
    queryKey: ["commercial.intelligence.customers"],
    queryFn: () => listIntel({ data: {} }),
  });

  if (rows.isLoading) return <LoadingState />;
  const data = (rows.data ?? []) as any[];

  return (
    <SectionCard
      title="Customer health"
      description="Health band and score are computed server-side from the same balance, ageing, renewal and usage records the Customers and Collections panels read — never a second calculation."
    >
      {data.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No customers yet"
          description="Nothing in the portfolio."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>MRR</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Renews</TableHead>
              <TableHead>Properties</TableHead>
              <TableHead>Open signals</TableHead>
              <TableHead>Open recommendations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.tenantId}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>
                  {healthBadge(c.healthBand)}
                  <span className="ml-2 text-xs text-muted-foreground">{c.healthScore}/100</span>
                </TableCell>
                <TableCell>{TZS(c.mrr)}</TableCell>
                <TableCell
                  className={Number(c.balance) > 0 ? "text-red-600 dark:text-red-400" : ""}
                >
                  {TZS(c.balance)}
                </TableCell>
                <TableCell>
                  {c.renewalDate ?? "—"}
                  {c.daysUntilRenewal != null && ` (${c.daysUntilRenewal}d)`}
                </TableCell>
                <TableCell>
                  {c.propertyCount} ({c.chargeablePropertyCount} chargeable)
                </TableCell>
                <TableCell>{c.openSignalCount}</TableCell>
                <TableCell>{c.openRecommendationCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

/* ================================================================ Signals */

export function SignalsPanel() {
  const qc = useQueryClient();
  const listSignals = useServerFn(listCommercialSignalsFn);
  const scan = useServerFn(runCommercialSignalScanFn);

  const [showResolved, setShowResolved] = useState(false);
  const signals = useQuery({
    queryKey: ["commercial.intelligence.signals", showResolved],
    queryFn: () => listSignals({ data: { status: showResolved ? "resolved" : "active" } }),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["commercial.intelligence"] });
  };

  const scanMutation = useAdminMutation({
    mutationFn: () => scan({ data: {} }),
    successMessage: "Signals rescanned",
    onSuccess: invalidateAll,
  });

  if (signals.isLoading) return <LoadingState />;
  const rows = (signals.data ?? []) as any[];

  return (
    <SectionCard
      title="Commercial signals"
      description="Recomputed on demand — this codebase has no scheduler. A rescan touches an already-active signal instead of duplicating it, and resolves one whose underlying condition has cleared."
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Show active" : "Show resolved"}
          </Button>
          <Button size="sm" disabled={scanMutation.isPending} onClick={() => scanMutation.mutate()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            Rescan
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={showResolved ? "No resolved signals" : "No active signals"}
          description={
            showResolved
              ? "Nothing has resolved yet."
              : "Run a rescan, or the portfolio is currently clean."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Signal</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">
                  {s.restaurant_tenants?.name ?? s.tenant_id}
                </TableCell>
                <TableCell className="text-xs uppercase text-muted-foreground">
                  {s.category}
                </TableCell>
                <TableCell>{severityBadge(s.severity)}</TableCell>
                <TableCell>
                  <div className="font-medium">{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.detail}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(s.last_seen_at).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

/* ========================================================= Recommendations */

export function RecommendationsPanel() {
  const qc = useQueryClient();
  const listRecs = useServerFn(listCommercialRecommendationsFn);
  const complete = useServerFn(completeCommercialRecommendationFn);
  const dismiss = useServerFn(dismissCommercialRecommendationFn);

  const [tab, setTab] = useState<"open" | "completed" | "dismissed">("open");
  const recs = useQuery({
    queryKey: ["commercial.intelligence.recommendations", tab],
    queryFn: () => listRecs({ data: { status: tab } }),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["commercial.intelligence.recommendations"] });

  const completeMutation = useAdminMutation({
    mutationFn: (v: { id: string; note?: string }) => complete({ data: v }),
    successMessage: "Recommendation completed",
    onSuccess: invalidate,
  });
  const dismissMutation = useAdminMutation({
    mutationFn: (v: { id: string; reason: string }) => dismiss({ data: v }),
    successMessage: "Recommendation dismissed",
    onSuccess: invalidate,
  });

  if (recs.isLoading) return <LoadingState />;
  const rows = (recs.data ?? []) as any[];

  return (
    <SectionCard
      title="Recommendations"
      description="Every recommendation is explainable and scoped to one customer. Completing one is the audited, controlled action — it records that the review or contact happened, it never triggers a financial mutation on its own."
      actions={
        <div className="flex gap-1">
          {(["open", "completed", "dismissed"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => setTab(t)}
            >
              {t}
            </Button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={`No ${tab} recommendations`}
          description={
            tab === "open" ? "Nothing needs review right now." : `Nothing has been ${tab} yet.`
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <RecommendationRow
              key={r.id}
              row={r}
              pending={completeMutation.isPending || dismissMutation.isPending}
              onComplete={(note) => completeMutation.mutate({ id: r.id, note })}
              onDismiss={(reason) => dismissMutation.mutate({ id: r.id, reason })}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function RecommendationRow({
  row,
  onComplete,
  onDismiss,
  pending,
}: {
  row: any;
  onComplete: (note?: string) => void;
  onDismiss: (reason: string) => void;
  pending: boolean;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-mono uppercase text-muted-foreground">{row.action_type}</div>
          <div className="font-medium">{row.title}</div>
          <div className="text-sm text-muted-foreground">{row.rationale}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {row.restaurant_tenants?.name ?? row.tenant_id} ·{" "}
            {new Date(row.created_at).toLocaleDateString()}
          </div>
          {row.resolution_note && (
            <div className="mt-1 text-xs italic text-muted-foreground">
              Note: {row.resolution_note}
            </div>
          )}
        </div>
        {row.status === "open" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => onComplete(note.trim() || undefined)}
            >
              Complete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onDismiss(note.trim() || "Dismissed from Commercial Centre")}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>
      {row.status === "open" && (
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (used as the reason if you dismiss)…"
          rows={1}
          className="mt-2 h-9 min-h-9"
        />
      )}
    </div>
  );
}
