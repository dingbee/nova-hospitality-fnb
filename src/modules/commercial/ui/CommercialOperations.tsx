/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * P03 — Commercial Operations Centre: the operational command layer over
 * P01 (policy) and P02 (transactions). Lives inside the existing Commercial
 * Centre as additional tabs — every read/write here is a thin view over
 * P01/P02 server functions; nothing here computes a price, a balance, or an
 * ageing bucket independently (see customers.server.ts / collections.server.ts
 * / renewals.server.ts / billing.server.ts, the single authoritative sources).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Receipt,
  Search,
  Users,
  Wallet,
} from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { COMMERCIAL_CUSTOMER_STATUSES } from "../contracts";
import {
  addCommercialNoteFn,
  cancelCommercialSubscriptionFn,
  getCommercialCustomerProfileFn,
  listCommercialCollectionsFn,
  listCommercialCustomersFn,
  listCommercialUpcomingRenewalsFn,
  renewCommercialSubscriptionFn,
  suspendCommercialSubscriptionFn,
} from "../commercial.functions";

const TZS = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Number(n)) + " TZS";

function statusBadge(status: string, tone: "default" | "warn" | "bad" | "good" = "default") {
  const cls =
    tone === "good"
      ? "border-emerald-400 text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "border-amber-400 text-amber-700 dark:text-amber-400"
        : tone === "bad"
          ? "border-red-400 text-red-700 dark:text-red-400"
          : "";
  return (
    <Badge variant="outline" className={cls}>
      {status}
    </Badge>
  );
}

/** §16 — Plan: PRO / Programme: FOUNDING_10, never "Plan: FOUNDING_10". A programme is always an overlay label, never substituted for the plan. */
function planProgrammeLabel(
  planCode: string | null | undefined,
  programmeCode: string | null | undefined,
) {
  const plan = planCode ? planCode.toUpperCase() : "—";
  if (!programmeCode) return `Plan: ${plan}`;
  return `Plan: ${plan} / Programme: ${programmeCode.toUpperCase()}`;
}

/* ======================================================= Commercial Overview */

export function CommercialOverviewPanel({
  subscriptions,
  propertyClassifications,
}: {
  subscriptions: any[];
  propertyClassifications: any[];
}) {
  const listCustomers = useServerFn(listCommercialCustomersFn);
  const listRenewals = useServerFn(listCommercialUpcomingRenewalsFn);
  const listCollections = useServerFn(listCommercialCollectionsFn);

  const customers = useQuery({
    queryKey: ["commercial.ops.customers", "all"],
    queryFn: () => listCustomers({ data: {} }),
  });
  const renewals = useQuery({
    queryKey: ["commercial.ops.renewals"],
    queryFn: () => listRenewals({ data: {} }),
  });
  const collections = useQuery({
    queryKey: ["commercial.ops.collections"],
    queryFn: () => listCollections({ data: {} }),
  });

  if (customers.isLoading || renewals.isLoading || collections.isLoading) return <LoadingState />;

  const cust = (customers.data ?? []) as any[];
  const custByStatus = (status: string) => cust.filter((c) => c.commercialStatus === status).length;

  const subByStatus = (status: string) =>
    subscriptions.filter((s: any) => s.status === status).length;

  const totalProperties = propertyClassifications.length;
  const chargeableProperties = propertyClassifications.filter((p: any) => p.chargeable).length;

  const ren = (renewals.data ?? []) as any[];
  const atRiskRenewals = ren.filter((r) => r.atRisk).length;
  const upcoming30 = ren.filter(
    (r) => r.daysUntilRenewal != null && r.daysUntilRenewal <= 30,
  ).length;

  const col = (collections.data ?? []) as any[];
  const outstandingTotal = col.reduce((s, c) => s + Number(c.balance), 0);
  const overdueTotal = col.filter((c) => c.ageingBucket !== "current").length;
  const ageingBuckets: Record<string, number> = { "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const c of col) if (c.ageingBucket !== "current") ageingBuckets[c.ageingBucket] += 1;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Customers — active"
          value={custByStatus("active")}
          icon={Users}
          hint={`${cust.length} total in portfolio`}
        />
        <StatCard label="Customers — suspended" value={custByStatus("suspended")} icon={Users} />
        <StatCard label="Customers — past due" value={custByStatus("past_due")} icon={Users} />
        <StatCard label="Customers — prospect" value={custByStatus("prospect")} icon={Users} />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Subscriptions — active" value={subByStatus("active")} icon={Wallet} />
        <StatCard label="Subscriptions — past due" value={subByStatus("past_due")} icon={Wallet} />
        <StatCard
          label="Subscriptions — suspended"
          value={subByStatus("suspended")}
          icon={Wallet}
        />
        <StatCard
          label="Subscriptions — cancelled"
          value={subByStatus("cancelled")}
          icon={Wallet}
        />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Properties"
          value={totalProperties}
          icon={Building2}
          hint={`${chargeableProperties} chargeable`}
        />
        <StatCard
          label="Renewals — next 30 days"
          value={upcoming30}
          icon={CalendarClock}
          hint={`${ren.length} tracked`}
        />
        <StatCard
          label="Renewals at risk"
          value={atRiskRenewals}
          icon={AlertTriangle}
          hint="past due or carrying a balance"
        />
        <StatCard
          label="Outstanding (collections)"
          value={TZS(outstandingTotal)}
          icon={Receipt}
          hint={`${overdueTotal} overdue invoices`}
        />
      </div>
      <SectionCard
        title="Ageing (Collections)"
        description="Computed at read time from each invoice's due date — this codebase has no scheduler, so there is no stored 'overdue' state to drift from reality."
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {(["1-30", "31-60", "61-90", "90+"] as const).map((bucket) => (
            <StatCard key={bucket} label={`${bucket} days`} value={ageingBuckets[bucket]} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

/* ============================================================== Customers */

export function CustomersPortfolioPanel() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("__all__");
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);

  const listCustomers = useServerFn(listCommercialCustomersFn);
  const customers = useQuery({
    queryKey: ["commercial.ops.customers", search, status],
    queryFn: () =>
      listCustomers({
        data: { search: search || undefined, status: status === "__all__" ? undefined : status },
      }),
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Customer portfolio"
        description="Every tenant with billing status, plan/programme, subscription state and outstanding balance — search and filter are server-side."
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Label>Search by name</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-8"
                placeholder="Customer name…"
              />
            </div>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All statuses</SelectItem>
                {COMMERCIAL_CUSTOMER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {customers.isLoading ? (
          <LoadingState />
        ) : (customers.data ?? []).length === 0 ? (
          <EmptyState
            icon={Users}
            title="No customers found"
            description="Adjust your search or filter."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Commercial status</TableHead>
                <TableHead>Plan / Programme</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Renews</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(customers.data ?? []).map((c: any) => (
                <TableRow key={c.tenantId}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    {statusBadge(
                      c.commercialStatus,
                      c.commercialStatus === "active"
                        ? "good"
                        : ["suspended", "cancelled"].includes(c.commercialStatus)
                          ? "bad"
                          : c.commercialStatus === "past_due"
                            ? "warn"
                            : "default",
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {planProgrammeLabel(c.planCode, c.programmeCode)}
                  </TableCell>
                  <TableCell>
                    {c.subscriptionStatus ? statusBadge(c.subscriptionStatus) : "—"}
                  </TableCell>
                  <TableCell>{c.renewalDate ?? "—"}</TableCell>
                  <TableCell
                    className={Number(c.balance) > 0 ? "text-red-600 dark:text-red-400" : ""}
                  >
                    {TZS(c.balance)}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelectedTenant(c.tenantId)}
                    >
                      Open profile
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {selectedTenant && (
        <CustomerProfilePanel tenantId={selectedTenant} onClose={() => setSelectedTenant(null)} />
      )}
    </div>
  );
}

function CustomerProfilePanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const getProfile = useServerFn(getCommercialCustomerProfileFn);
  const addNote = useServerFn(addCommercialNoteFn);

  const profile = useQuery({
    queryKey: ["commercial.ops.profile", tenantId],
    queryFn: () => getProfile({ data: { tenantId } }),
  });

  const noteMutation = useAdminMutation({
    mutationFn: (vars: any) => addNote({ data: vars }),
    successMessage: "Note recorded to commercial activity",
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: ["commercial.ops.profile", tenantId] });
    },
  });

  if (profile.isLoading) return <LoadingState />;
  const p = profile.data;
  if (!p) return null;

  return (
    <SectionCard
      title={`Customer profile — ${p.tenant.name}`}
      description="Who this customer is, what they signed, what they owe, and when they renew — assembled in one read from the authoritative P01/P02 records."
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Billing contact</dt>
            <dd>{p.billingAccount?.billing_contact_email ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Commercial status</dt>
            <dd>{p.billingAccount?.commercial_status ?? "prospect"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Plan / Programme</dt>
            <dd>
              {planProgrammeLabel(
                p.subscription?.commercial_plans?.code,
                p.subscription?.commercial_programmes?.code,
              )}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subscription status</dt>
            <dd>{p.subscription?.status ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Renews</dt>
            <dd>{p.subscription?.renewal_date ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Current agreement</dt>
            <dd className="font-mono text-xs">{p.currentAgreement?.contract_reference ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Outstanding balance</dt>
            <dd
              className={
                Number(p.balance) > 0 ? "font-medium text-red-600 dark:text-red-400" : "font-medium"
              }
            >
              {TZS(p.balance)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Properties</dt>
            <dd>
              {p.properties.length} ({p.properties.filter((pr: any) => pr.chargeable).length}{" "}
              chargeable)
            </dd>
          </div>
        </dl>

        <div>
          <Label>Add commercial note</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. Called about renewal…"
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={noteMutation.isPending || note.trim().length < 3}
              onClick={() => noteMutation.mutate({ tenantId, note: note.trim() })}
            >
              Record note
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-medium">Recent invoices</h4>
          {p.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.invoices.slice(0, 10).map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.invoice_number}</TableCell>
                    <TableCell>{i.status}</TableCell>
                    <TableCell>{TZS(i.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-medium">Recent activity</h4>
          {p.activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {p.activity.slice(0, 10).map((a: any) => (
                <li key={a.id} className="flex justify-between border-b border-border/50 pb-1">
                  <span>
                    {a.action}
                    {a.reason ? ` — ${a.reason}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/* =============================================================== Renewals */

export function RenewalsPanel({ plans }: { plans: any[] }) {
  const qc = useQueryClient();
  const listRenewals = useServerFn(listCommercialUpcomingRenewalsFn);
  const renew = useServerFn(renewCommercialSubscriptionFn);
  const cancelSub = useServerFn(cancelCommercialSubscriptionFn);

  const renewals = useQuery({
    queryKey: ["commercial.ops.renewals"],
    queryFn: () => listRenewals({ data: {} }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["commercial.ops.renewals"] });

  const renewM = useAdminMutation({
    mutationFn: (v: any) => renew({ data: v }),
    successMessage:
      "Renewal recorded — a new agreement was created, the prior one is now historical",
    onSuccess: invalidate,
  });
  const cancelM = useAdminMutation({
    mutationFn: (v: any) => cancelSub({ data: v }),
    successMessage: "Subscription cancelled",
    onSuccess: invalidate,
  });

  if (renewals.isLoading) return <LoadingState />;
  const rows = (renewals.data ?? []) as any[];

  return (
    <SectionCard
      title="Upcoming renewals"
      description="Renew, upgrade, downgrade or cancel — every action creates a fresh agreement snapshot (or the appropriate lifecycle transition) and never rewrites a historical one."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No tracked renewals"
          description="No subscription currently has a renewal date on record."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Plan / Programme</TableHead>
              <TableHead>Renews</TableHead>
              <TableHead>Properties</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <RenewalRow
                key={r.subscriptionId}
                row={r}
                plans={plans}
                onRenew={(newPlanId) =>
                  renewM.mutate({
                    tenantId: r.tenantId,
                    keepDiscount: true,
                    newPlanId: newPlanId || undefined,
                    reason: newPlanId ? "Plan change at renewal" : "Renewal",
                  })
                }
                onCancel={() =>
                  cancelM.mutate({ tenantId: r.tenantId, reason: "Cancelled at renewal review" })
                }
                pending={renewM.isPending || cancelM.isPending}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function RenewalRow({
  row,
  plans,
  onRenew,
  onCancel,
  pending,
}: {
  row: any;
  plans: any[];
  onRenew: (newPlanId: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [newPlanId, setNewPlanId] = useState("__same__");
  return (
    <TableRow>
      <TableCell className="font-medium">{row.customerName}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {planProgrammeLabel(row.planCode, row.programmeCode)}
      </TableCell>
      <TableCell>
        {row.renewalDate} {row.daysUntilRenewal != null && `(${row.daysUntilRenewal}d)`}
      </TableCell>
      <TableCell>
        {row.propertyCount} ({row.chargeablePropertyCount} chargeable)
      </TableCell>
      <TableCell className={row.outstandingBalance > 0 ? "text-red-600 dark:text-red-400" : ""}>
        {TZS(row.outstandingBalance)}
      </TableCell>
      <TableCell>
        {row.atRisk ? statusBadge("at risk", "bad") : statusBadge("on track", "good")}
      </TableCell>
      <TableCell className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={newPlanId} onValueChange={setNewPlanId}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__same__">Same plan</SelectItem>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => onRenew(newPlanId === "__same__" ? "" : newPlanId)}
          >
            {newPlanId === "__same__" ? "Renew" : "Renew with plan change"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ============================================================= Collections */

export function CollectionsPanel() {
  const qc = useQueryClient();
  const listCollections = useServerFn(listCommercialCollectionsFn);
  const suspend = useServerFn(suspendCommercialSubscriptionFn);
  const renew = useServerFn(renewCommercialSubscriptionFn);

  const collections = useQuery({
    queryKey: ["commercial.ops.collections"],
    queryFn: () => listCollections({ data: {} }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["commercial.ops.collections"] });

  const suspendM = useAdminMutation({
    mutationFn: (v: any) => suspend({ data: v }),
    successMessage: "Subscription suspended",
    onSuccess: invalidate,
  });
  const renewM = useAdminMutation({
    mutationFn: (v: any) => renew({ data: v }),
    successMessage: "Renewal recorded",
    onSuccess: invalidate,
  });

  if (collections.isLoading) return <LoadingState />;
  const rows = (collections.data ?? []) as any[];

  const bucketTone = (bucket: string) =>
    bucket === "current"
      ? ("default" as const)
      : bucket === "1-30"
        ? ("warn" as const)
        : ("bad" as const);

  return (
    <SectionCard
      title="Collections — overdue receivables"
      description="Issued and partially-paid invoices, ordered most-overdue-first. Ageing is computed at read time from the due date — there is no scheduler in this codebase to drift it out of sync."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Nothing outstanding"
          description="No issued or partially-paid invoices right now."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Ageing</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Renews</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.invoiceId}>
                <TableCell className="font-medium">{c.customerName}</TableCell>
                <TableCell className="font-mono text-xs">{c.invoiceNumber}</TableCell>
                <TableCell>
                  {statusBadge(
                    c.ageingBucket === "current" ? "current" : `${c.ageingBucket}d overdue`,
                    bucketTone(c.ageingBucket),
                  )}
                </TableCell>
                <TableCell>{TZS(c.balance)}</TableCell>
                <TableCell>{c.renewalDate ?? "—"}</TableCell>
                <TableCell className="space-x-2 whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={suspendM.isPending}
                    onClick={() =>
                      suspendM.mutate({
                        tenantId: c.tenantId,
                        reason: `Overdue invoice ${c.invoiceNumber}`,
                      })
                    }
                  >
                    Suspend
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={renewM.isPending}
                    onClick={() =>
                      renewM.mutate({
                        tenantId: c.tenantId,
                        keepDiscount: true,
                        reason: "Renewal from collections",
                      })
                    }
                  >
                    Renew
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
