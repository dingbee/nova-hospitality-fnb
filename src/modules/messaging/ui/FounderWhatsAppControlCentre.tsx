/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this UI boundary. */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  AlertTriangle,
  Building2,
  CreditCard,
  MessageSquare,
  ShieldCheck,
  Smartphone,
  Webhook,
} from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { getFounderWhatsAppOverviewFn } from "../operations.functions";

function amount(value: number, currency: string) {
  return `${currency} ${Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function FounderWhatsAppControlCentre() {
  const overviewFn = useServerFn(getFounderWhatsAppOverviewFn);
  const overview = useQuery({
    queryKey: ["founder", "whatsapp", "overview"],
    queryFn: () => overviewFn({ data: {} }),
    refetchInterval: 60_000,
  });

  if (overview.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading founder WhatsApp control centre…
      </div>
    );
  }
  if (overview.isError || !overview.data) {
    return (
      <EmptyState
        title="Platform WhatsApp data unavailable"
        description="The founder-authorized operational overview could not be loaded."
        icon={AlertTriangle}
      />
    );
  }

  const data = overview.data as any;
  const activeBindings = data.bindings.filter((row: any) => row.status === "active").length;
  const deadLetters = data.webhookHealth.deadLetters ?? 0;
  const rejected = data.webhookHealth.rejected ?? 0;
  const failedMessages = data.messageHealth.failed ?? 0;
  const usageEntries = Object.entries(data.usage ?? {}) as Array<[string, number]>;
  const usageUnpricedEntries = Object.entries(data.usageUnpriced ?? {}) as Array<[string, number]>;

  return (
    <div className="space-y-4">
      <PageHeader
        title="WhatsApp Platform Control"
        description="Founder-only provider onboarding, connection health, usage, billing evidence and security posture."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Provider integrations"
          value={String(data.integrationCount)}
          icon={Smartphone}
        />
        <StatCard label="Phone bindings" value={String(data.bindings.length)} icon={Building2} />
        <StatCard label="Active bindings" value={String(activeBindings)} icon={Activity} />
        <StatCard
          label="Failed outbound messages"
          value={String(failedMessages)}
          icon={MessageSquare}
          tone={failedMessages > 0 ? "warn" : "green"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Provider and tenant bindings"
          description="Scoped WABA/phone assets and integration status. Credentials and tokens are never returned."
        >
          {data.bindings.length === 0 ? (
            <EmptyState
              title="No WhatsApp bindings"
              description="Verified tenant/property phone-number bindings will appear after onboarding."
              icon={Smartphone}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3">Property / outlet</th>
                    <th className="py-2 pr-3">Phone asset</th>
                    <th className="py-2 pr-3">Quality</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.bindings.map((row: any) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{row.tenant?.name ?? row.tenant_id}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.tenant?.slug ?? ""}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-xs">{row.property_id}</div>
                        <div className="text-xs text-muted-foreground">{row.location_id}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <div>{row.display_phone_number ?? row.phone_number_id}</div>
                        <div className="text-xs text-muted-foreground">WABA {row.waba_id}</div>
                      </td>
                      <td className="py-2 pr-3">{row.quality_rating ?? "Not reported"}</td>
                      <td className="py-2">
                        <StatusChip>{row.status}</StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Webhook and dispatch health"
          description="Operational evidence from the webhook inbox and canonical outbound queue."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Webhook className="size-4" /> Webhook events
              </div>
              <p className="mt-2 text-2xl font-semibold">{data.webhookHealth.total}</p>
              <p className="text-xs text-muted-foreground">Recent stored events</p>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <MessageSquare className="size-4" /> Outbound messages
              </div>
              <p className="mt-2 text-2xl font-semibold">{data.messageHealth.total}</p>
              <p className="text-xs text-muted-foreground">Recent queue records</p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Dead-letter webhooks</span>
              <StatusChip tone={deadLetters > 0 ? "danger" : "success"}>{deadLetters}</StatusChip>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Rejected webhooks</span>
              <StatusChip tone={rejected > 0 ? "warning" : "success"}>{rejected}</StatusChip>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Failed messages</span>
              <StatusChip tone={failedMessages > 0 ? "warning" : "success"}>
                {failedMessages}
              </StatusChip>
            </div>
          </div>
          <div className="mt-4 border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Webhook state</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.webhookHealth.byStatus ?? {}).map(([key, value]) => (
                <StatusChip key={key}>
                  {key}: {String(value)}
                </StatusChip>
              ))}
            </div>
            <p className="mb-2 mt-3 text-xs font-medium text-muted-foreground">Outbound state</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.messageHealth.byStatus ?? {}).map(([key, value]) => (
                <StatusChip key={key}>
                  {key}: {String(value)}
                </StatusChip>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Usage and cost attribution"
          description="WCE-06 append-only usage ledger, kept separate by component and currency."
        >
          {usageEntries.length === 0 && usageUnpricedEntries.length === 0 ? (
            <EmptyState
              title="No usage ledger entries"
              description="Provider, LexiBite commercial and AI usage evidence will appear here."
            />
          ) : (
            <ul className="divide-y">
              {usageEntries.map(([key, value]) => {
                const [component, currency] = key.split(":");
                return (
                  <li key={key} className="flex items-center justify-between gap-3 py-3">
                    <span className="text-sm capitalize">
                      {component.replaceAll("_", " ")}{" "}
                      <span className="text-xs text-muted-foreground"> {currency}</span>
                    </span>
                    <strong className="text-sm">{amount(value, currency)}</strong>
                  </li>
                );
              })}
              {usageUnpricedEntries.map(([key, count]) => {
                const [component, currency] = key.split(":");
                return (
                  <li
                    key={key + ":unpriced"}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <span className="text-sm capitalize">
                      {component.replaceAll("_", " ")}{" "}
                      <span className="text-xs text-muted-foreground"> {currency}</span>
                    </span>
                    <strong className="text-sm">{count} unpriced usage record(s)</strong>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Commercial billing evidence"
          description="Invoice and balance totals sourced from the existing commercial billing ledger."
        >
          <div className="mb-3 flex items-center gap-2 text-sm">
            <CreditCard className="size-4" /> {data.invoiceSummary.count} invoice(s)
          </div>
          {(data.invoiceSummary.byCurrency ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No commercial invoices recorded.</p>
          ) : (
            <ul className="divide-y">
              {data.invoiceSummary.byCurrency.map((row: any) => (
                <li key={row.currency} className="space-y-1 py-3">
                  <p className="font-medium">{row.currency}</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Issued invoice value</span>
                    <strong>{amount(row.issuedAmount, row.currency)}</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Outstanding balance</span>
                    <strong>{amount(row.outstandingBalance, row.currency)}</strong>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="LexiBite commercial quota consumption"
        description="Current-period WhatsApp campaign-message usage from the existing commercial quota counters."
      >
        {(data.lexibiteQuotaUsage ?? []).length === 0 ? (
          <EmptyState
            title="No campaign quota counters"
            description="No active-period WhatsApp campaign quota usage is recorded."
            icon={CreditCard}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Tenant</th>
                  <th className="py-2 pr-3">Property</th>
                  <th className="py-2 pr-3">Consumption</th>
                  <th className="py-2 pr-3">Quota period</th>
                  <th className="py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.lexibiteQuotaUsage.map((row: any, index: number) => (
                  <tr
                    key={
                      row.tenant_id +
                      ":" +
                      row.property_id +
                      ":" +
                      row.quota_definition_id +
                      ":" +
                      index
                    }
                  >
                    <td className="py-2 pr-3">{row.tenant?.name ?? row.tenant_id}</td>
                    <td className="py-2 pr-3 text-xs">{row.property_id ?? "Tenant-wide"}</td>
                    <td className="py-2 pr-3 font-medium">
                      {Number(row.used_value).toLocaleString()} {row.quota?.unit ?? "units"}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {new Date(row.period_start).toLocaleDateString()}{" – "}
                      {new Date(row.period_end).toLocaleDateString()}
                    </td>
                    <td className="py-2">
                      <StatusChip>{row.state}</StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Security posture"
        description="Founder-only review signals; investigate failures before enabling provider dispatch."
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-muted-foreground" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Credential material is excluded from this view.</p>
            <p className="text-muted-foreground">
              Review rejected webhooks, dead-letter events, failed outbound messages and inactive
              bindings before any production enablement. Campaign dispatch and Meta template
              submission remain default-off in UAT.
            </p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
