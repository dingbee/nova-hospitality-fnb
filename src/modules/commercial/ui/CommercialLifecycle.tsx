/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * P02 — Commercial lifecycle workspace: agreements, subscription
 * activation/renewal/cancellation, invoicing and payments. Lives inside the
 * existing Commercial Centre (P01's `CommercialCentre.tsx`) as additional
 * tabs — not a second admin app.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, FileText, Receipt, Wallet } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { PAYMENT_METHODS } from "../contracts";
import {
  activateCommercialSubscriptionFn,
  approveCommercialAgreementFn,
  cancelCommercialAgreementFn,
  cancelCommercialSubscriptionFn,
  createCommercialAgreementFn,
  generateCommercialInvoiceFn,
  getCommercialBillingAccountFn,
  issueCommercialInvoiceFn,
  listCommercialAgreementsFn,
  listCommercialInvoicesFn,
  listCommercialNotificationsFn,
  listCommercialPaymentsFn,
  reactivateCommercialSubscriptionFn,
  recordCommercialPaymentFn,
  renderCommercialDocumentHtmlFn,
  renewCommercialSubscriptionFn,
  suspendCommercialSubscriptionFn,
  upsertCommercialBillingAccountFn,
  voidCommercialInvoiceFn,
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

function invoiceTone(status: string, overdue: boolean) {
  if (overdue) return "bad" as const;
  if (status === "paid") return "good" as const;
  if (status === "issued" || status === "partially_paid") return "warn" as const;
  return "default" as const;
}

/* ============================================================== overview */

export function BillingOverviewPanel({ subscriptions }: { subscriptions: any[] }) {
  const listInvoices = useServerFn(listCommercialInvoicesFn);
  const listPayments = useServerFn(listCommercialPaymentsFn);
  const invoices = useQuery({
    queryKey: ["commercial.invoices.all"],
    queryFn: () => listInvoices({ data: {} }),
  });
  const payments = useQuery({
    queryKey: ["commercial.payments.all"],
    queryFn: () => listPayments({ data: {} }),
  });

  if (invoices.isLoading || payments.isLoading) return <LoadingState />;
  const inv = (invoices.data ?? []) as any[];
  const pay = (payments.data ?? []) as any[];

  const activeSubs = subscriptions.filter((s: any) => s.status === "active");
  // MRR: every active subscription's monthly-equivalent charge, read from
  // its agreement price snapshot (annual ÷ 12) — never the live pricing
  // catalogue, and never combined with one-time charges (§34).
  const mrr = activeSubs.reduce((sum: number, s: any) => {
    const agreement = s.commercial_agreements;
    if (!agreement) return sum;
    const monthly =
      s.billing_interval === "annual"
        ? agreement.annual_price != null
          ? Number(agreement.annual_price) / 12
          : 0
        : Number(agreement.monthly_price ?? 0);
    return sum + monthly;
  }, 0);
  const arr = mrr * 12;
  const outstanding = inv
    .filter((i) => ["issued", "partially_paid"].includes(i.status))
    .reduce((s, i) => s + Number(i.balance), 0);
  const overdueCount = inv.filter((i) => i.overdue).length;
  const collected = pay.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="MRR"
          value={TZS(mrr)}
          icon={Wallet}
          hint={`${activeSubs.length} active subscriptions`}
        />
        <StatCard label="ARR" value={TZS(arr)} icon={Wallet} hint="MRR × 12" />
        <StatCard label="Outstanding receivables" value={TZS(outstanding)} icon={Receipt} />
        <StatCard
          label="Overdue invoices"
          value={overdueCount}
          icon={AlertTriangle}
          hint={overdueCount > 0 ? "Needs follow-up" : "None"}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard label="Collected (all time)" value={TZS(collected)} icon={FileText} />
      </div>
      <SectionCard
        title="All invoices"
        description="Every commercial invoice across all tenants — status is computed at read time (this codebase has no scheduler, so 'overdue' is derived from the due date, not a stored automatic transition)."
      >
        {inv.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inv.slice(0, 50).map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.invoice_number}</TableCell>
                  <TableCell>{i.restaurant_tenants?.name ?? i.tenant_id}</TableCell>
                  <TableCell>
                    {statusBadge(
                      i.overdue ? "OVERDUE" : i.status,
                      invoiceTone(i.status, i.overdue),
                    )}
                  </TableCell>
                  <TableCell>{TZS(i.total)}</TableCell>
                  <TableCell>{TZS(i.balance)}</TableCell>
                  <TableCell>{i.due_date ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

/* =========================================================== customer 360 */

export function CustomerWorkspacePanel({
  tenants,
  plans,
  programmes,
}: {
  tenants: { id: string; name: string }[];
  plans: any[];
  programmes: any[];
}) {
  const [tenantId, setTenantId] = useState<string>(tenants[0]?.id ?? "");
  if (tenants.length === 0) {
    return (
      <EmptyState icon={Wallet} title="No tenants" description="No restaurant tenants exist yet." />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Label className="shrink-0">Customer</Label>
        <Select value={tenantId} onValueChange={setTenantId}>
          <SelectTrigger className="h-9 w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {tenantId && <CustomerWorkspace tenantId={tenantId} plans={plans} programmes={programmes} />}
    </div>
  );
}

function CustomerWorkspace({
  tenantId,
  plans,
  programmes,
}: {
  tenantId: string;
  plans: any[];
  programmes: any[];
}) {
  const qc = useQueryClient();
  const listAgreements = useServerFn(listCommercialAgreementsFn);
  const listInvoices = useServerFn(listCommercialInvoicesFn);
  const listPayments = useServerFn(listCommercialPaymentsFn);
  const getBillingAccount = useServerFn(getCommercialBillingAccountFn);
  const listNotifications = useServerFn(listCommercialNotificationsFn);

  const agreements = useQuery({
    queryKey: ["commercial.agreements", tenantId],
    queryFn: () => listAgreements({ data: { tenantId } }),
  });
  const invoices = useQuery({
    queryKey: ["commercial.invoices", tenantId],
    queryFn: () => listInvoices({ data: { tenantId } }),
  });
  const payments = useQuery({
    queryKey: ["commercial.payments", tenantId],
    queryFn: () => listPayments({ data: { tenantId } }),
  });
  const billingAccount = useQuery({
    queryKey: ["commercial.billingAccount", tenantId],
    queryFn: () => getBillingAccount({ data: { tenantId } }),
  });
  const notifications = useQuery({
    queryKey: ["commercial.notifications", tenantId],
    queryFn: () => listNotifications({ data: { tenantId } }),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["commercial.agreements", tenantId] });
    qc.invalidateQueries({ queryKey: ["commercial.invoices", tenantId] });
    qc.invalidateQueries({ queryKey: ["commercial.payments", tenantId] });
    qc.invalidateQueries({ queryKey: ["commercial.billingAccount", tenantId] });
    qc.invalidateQueries({ queryKey: ["commercial.subscriptions"] });
    qc.invalidateQueries({ queryKey: ["commercial.invoices.all"] });
    qc.invalidateQueries({ queryKey: ["commercial.payments.all"] });
  };

  if (agreements.isLoading || invoices.isLoading || billingAccount.isLoading)
    return <LoadingState />;

  const currentAgreement = (agreements.data ?? []).find((a: any) =>
    ["active", "approved"].includes(a.status),
  );

  return (
    <div className="space-y-6">
      <BillingAccountCard
        tenantId={tenantId}
        account={billingAccount.data}
        onSaved={invalidateAll}
      />
      <AgreementsCard
        tenantId={tenantId}
        plans={plans}
        programmes={programmes}
        agreements={agreements.data ?? []}
        onSaved={invalidateAll}
      />
      {currentAgreement && (
        <SubscriptionActionsCard
          tenantId={tenantId}
          agreement={currentAgreement}
          onSaved={invalidateAll}
        />
      )}
      <InvoicesCard tenantId={tenantId} invoices={invoices.data ?? []} onSaved={invalidateAll} />
      <PaymentsCard
        invoices={invoices.data ?? []}
        payments={payments.data ?? []}
        onSaved={invalidateAll}
      />
      <SectionCard
        title="Notification history"
        description="Every commercial email attempt for this tenant, reusing the same send path as receipts and supplier communication."
      >
        {(notifications.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No notifications sent yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(notifications.data ?? []).map((n: any) => (
                <TableRow key={n.id}>
                  <TableCell>{n.event_type}</TableCell>
                  <TableCell>
                    {statusBadge(
                      n.status,
                      n.status === "sent" ? "good" : n.status === "failed" ? "bad" : "default",
                    )}
                  </TableCell>
                  <TableCell>{n.recipient ?? "—"}</TableCell>
                  <TableCell>{new Date(n.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

function BillingAccountCard({
  tenantId,
  account,
  onSaved,
}: {
  tenantId: string;
  account: any;
  onSaved: () => void;
}) {
  const [name, setName] = useState(account?.billing_contact_name ?? "");
  const [email, setEmail] = useState(account?.billing_contact_email ?? "");
  const [phone, setPhone] = useState(account?.billing_contact_phone ?? "");
  const upsert = useServerFn(upsertCommercialBillingAccountFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Billing account saved",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Billing account"
      description={
        account
          ? `Commercial status: ${account.commercial_status}`
          : 'No billing account yet — saving contact details creates one as "prospect".'
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <Label>Billing contact name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
        </div>
        <div>
          <Label>Billing email</Label>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9"
            type="email"
          />
        </div>
        <div>
          <Label>Billing phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate({
              tenantId,
              billingContactName: name || undefined,
              billingContactEmail: email || undefined,
              billingContactPhone: phone || undefined,
            })
          }
        >
          Save
        </Button>
      </div>
    </SectionCard>
  );
}

function AgreementsCard({
  tenantId,
  plans,
  programmes,
  agreements,
  onSaved,
}: {
  tenantId: string;
  plans: any[];
  programmes: any[];
  agreements: any[];
  onSaved: () => void;
}) {
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [programmeId, setProgrammeId] = useState("__none__");
  const [billingInterval, setBillingInterval] = useState("monthly");
  const [discountPct, setDiscountPct] = useState("");

  const create = useServerFn(createCommercialAgreementFn);
  const approve = useServerFn(approveCommercialAgreementFn);
  const cancel = useServerFn(cancelCommercialAgreementFn);

  const createMutation = useAdminMutation({
    mutationFn: (vars: any) => create({ data: vars }),
    successMessage: "Agreement created",
    onSuccess: onSaved,
  });
  const approveMutation = useAdminMutation({
    mutationFn: (vars: any) => approve({ data: vars }),
    successMessage: "Agreement approved",
    onSuccess: onSaved,
  });
  const cancelMutation = useAdminMutation({
    mutationFn: (vars: any) => cancel({ data: vars }),
    successMessage: "Agreement cancelled",
    onSuccess: onSaved,
  });

  return (
    <SectionCard
      title="Commercial agreements"
      description="Every agreement freezes the plan's live price at the moment it's created — a later pricing-catalogue change never rewrites it."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label>Plan</Label>
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Programme</Label>
          <Select value={programmeId} onValueChange={setProgrammeId}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {programmes.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Billing interval</Label>
          <Select value={billingInterval} onValueChange={setBillingInterval}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="annual">Annual</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Discount %</Label>
          <Input
            value={discountPct}
            onChange={(e) => setDiscountPct(e.target.value)}
            className="h-9"
            placeholder="optional"
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={createMutation.isPending || !planId}
          onClick={() =>
            createMutation.mutate({
              tenantId,
              planId,
              programmeId: programmeId === "__none__" ? undefined : programmeId,
              billingInterval,
              discountPct: discountPct ? Number(discountPct) : undefined,
            })
          }
        >
          Create draft agreement
        </Button>
      </div>

      {agreements.length > 0 && (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Monthly</TableHead>
              <TableHead>Annual</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {agreements.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">{a.contract_reference}</TableCell>
                <TableCell>{a.commercial_plans?.code?.toUpperCase() ?? "—"}</TableCell>
                <TableCell>
                  {statusBadge(
                    a.status,
                    a.status === "active" ? "good" : a.status === "cancelled" ? "bad" : "default",
                  )}
                </TableCell>
                <TableCell>{TZS(a.monthly_price)}</TableCell>
                <TableCell>{TZS(a.annual_price)}</TableCell>
                <TableCell className="space-x-2">
                  {["draft", "submitted"].includes(a.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={approveMutation.isPending}
                      onClick={() => approveMutation.mutate({ agreementId: a.id })}
                    >
                      Approve
                    </Button>
                  )}
                  {!["cancelled", "superseded"].includes(a.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancelMutation.isPending}
                      onClick={() =>
                        cancelMutation.mutate({
                          agreementId: a.id,
                          reason: "Cancelled from Commercial Centre",
                        })
                      }
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function SubscriptionActionsCard({
  tenantId,
  agreement,
  onSaved,
}: {
  tenantId: string;
  agreement: any;
  onSaved: () => void;
}) {
  const activate = useServerFn(activateCommercialSubscriptionFn);
  const suspend = useServerFn(suspendCommercialSubscriptionFn);
  const reactivate = useServerFn(reactivateCommercialSubscriptionFn);
  const cancelSub = useServerFn(cancelCommercialSubscriptionFn);
  const renew = useServerFn(renewCommercialSubscriptionFn);

  const activateM = useAdminMutation({
    mutationFn: (v: any) => activate({ data: v }),
    successMessage: "Subscription activated",
    onSuccess: onSaved,
  });
  const suspendM = useAdminMutation({
    mutationFn: (v: any) => suspend({ data: v }),
    successMessage: "Subscription suspended",
    onSuccess: onSaved,
  });
  const reactivateM = useAdminMutation({
    mutationFn: (v: any) => reactivate({ data: v }),
    successMessage: "Subscription reactivated",
    onSuccess: onSaved,
  });
  const cancelM = useAdminMutation({
    mutationFn: (v: any) => cancelSub({ data: v }),
    successMessage: "Subscription cancelled",
    onSuccess: onSaved,
  });
  const renewM = useAdminMutation({
    mutationFn: (v: any) => renew({ data: v }),
    successMessage: "Subscription renewed",
    onSuccess: onSaved,
  });

  return (
    <SectionCard
      title="Subscription lifecycle"
      description={`Current agreement: ${agreement.contract_reference} (${agreement.status}).`}
    >
      <div className="flex flex-wrap gap-2">
        {agreement.status === "approved" && (
          <Button
            size="sm"
            disabled={activateM.isPending}
            onClick={() => activateM.mutate({ agreementId: agreement.id })}
          >
            Activate subscription
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={suspendM.isPending}
          onClick={() => suspendM.mutate({ tenantId, reason: "Suspended from Commercial Centre" })}
        >
          Suspend
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={reactivateM.isPending}
          onClick={() =>
            reactivateM.mutate({ tenantId, reason: "Reactivated from Commercial Centre" })
          }
        >
          Reactivate
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={renewM.isPending}
          onClick={() => renewM.mutate({ tenantId, keepDiscount: true, reason: "Renewal" })}
        >
          Renew
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={cancelM.isPending}
          onClick={() => cancelM.mutate({ tenantId, reason: "Cancelled from Commercial Centre" })}
        >
          Cancel subscription
        </Button>
      </div>
    </SectionCard>
  );
}

function InvoicesCard({
  tenantId,
  invoices,
  onSaved,
}: {
  tenantId: string;
  invoices: any[];
  onSaved: () => void;
}) {
  const today = new Date();
  const periodStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
  const [includeImplementation, setIncludeImplementation] = useState(false);

  const generate = useServerFn(generateCommercialInvoiceFn);
  const issue = useServerFn(issueCommercialInvoiceFn);
  const voidInv = useServerFn(voidCommercialInvoiceFn);
  const render = useServerFn(renderCommercialDocumentHtmlFn);

  const generateM = useAdminMutation({
    mutationFn: (v: any) => generate({ data: v }),
    successMessage: "Draft invoice generated",
    onSuccess: onSaved,
  });
  const issueM = useAdminMutation({
    mutationFn: (v: any) => issue({ data: v }),
    successMessage: "Invoice issued",
    onSuccess: onSaved,
  });
  const voidM = useAdminMutation({
    mutationFn: (v: any) => voidInv({ data: v }),
    successMessage: "Invoice voided",
    onSuccess: onSaved,
  });

  const openPrint = async (invoiceId: string) => {
    const res = await render({ data: { kind: "invoice", id: invoiceId } });
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(res.html);
      w.document.close();
    }
  };

  return (
    <SectionCard
      title="Invoices"
      description={`Current billing period: ${periodStart} to ${periodEnd}.`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeImplementation}
            onChange={(e) => setIncludeImplementation(e.target.checked)}
          />
          Include implementation fee
        </label>
        <Button
          size="sm"
          disabled={generateM.isPending}
          onClick={() =>
            generateM.mutate({
              tenantId,
              billingPeriodStart: periodStart,
              billingPeriodEnd: periodEnd,
              includeImplementationFee: includeImplementation,
            })
          }
        >
          Generate invoice for current period
        </Button>
      </div>

      {invoices.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No invoices yet.</p>
      ) : (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Due</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((i: any) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">{i.invoice_number}</TableCell>
                <TableCell>
                  {statusBadge(i.overdue ? "OVERDUE" : i.status, invoiceTone(i.status, i.overdue))}
                </TableCell>
                <TableCell>{TZS(i.total)}</TableCell>
                <TableCell>{TZS(i.balance)}</TableCell>
                <TableCell>{i.due_date ?? "—"}</TableCell>
                <TableCell className="space-x-2 whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => openPrint(i.id)}>
                    View
                  </Button>
                  {i.status === "draft" && (
                    <Button
                      size="sm"
                      disabled={issueM.isPending}
                      onClick={() => issueM.mutate({ invoiceId: i.id })}
                    >
                      Issue
                    </Button>
                  )}
                  {!["paid", "void", "cancelled"].includes(i.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={voidM.isPending}
                      onClick={() =>
                        voidM.mutate({ invoiceId: i.id, reason: "Voided from Commercial Centre" })
                      }
                    >
                      Void
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function PaymentsCard({
  invoices,
  payments,
  onSaved,
}: {
  invoices: any[];
  payments: any[];
  onSaved: () => void;
}) {
  const payable = invoices.filter((i: any) => ["issued", "partially_paid"].includes(i.status));
  const [invoiceId, setInvoiceId] = useState(payable[0]?.id ?? "");
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");

  const record = useServerFn(recordCommercialPaymentFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => record({ data: vars }),
    successMessage: "Payment recorded",
    onSuccess: () => {
      setAmount("");
      setReference("");
      onSaved();
    },
  });

  return (
    <SectionCard
      title="Record a payment"
      description="No payment gateway is connected in this environment — record a bank transfer / mobile money reference you have already received. This is never inferred from a client-side callback."
    >
      {payable.length === 0 ? (
        <p className="text-sm text-muted-foreground">No unpaid invoices.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div>
            <Label>Invoice</Label>
            <Select value={invoiceId} onValueChange={setInvoiceId}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {payable.map((i: any) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.invoice_number} — balance {TZS(i.balance)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amount (TZS)</Label>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-9"
              type="number"
            />
          </div>
          <div>
            <Label>Reference</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="h-9"
              placeholder="transaction ref"
            />
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={mutation.isPending || !invoiceId || !amount}
          onClick={() =>
            mutation.mutate({
              invoiceId,
              method,
              amount: Number(amount),
              providerReference: reference || undefined,
              idempotencyKey: `ui-${invoiceId}-${Date.now()}`,
            })
          }
        >
          Record payment
        </Button>
      </div>

      {payments.length > 0 && (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">
                  {p.commercial_invoices?.invoice_number ?? "—"}
                </TableCell>
                <TableCell>{p.method.replace(/_/g, " ")}</TableCell>
                <TableCell>{TZS(p.amount)}</TableCell>
                <TableCell>{p.provider_reference ?? "—"}</TableCell>
                <TableCell>{new Date(p.received_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
