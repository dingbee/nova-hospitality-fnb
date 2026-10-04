/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Settings -> Payments -> Mobile Money.
 *
 * "Enter Lipa Namba -> Activate -> ON." Everything below the activation
 * toggle (mode, provider, environment) is present but stays secondary —
 * the operator's whole job is: pick a network, type the merchant number,
 * hit Activate. No API/OAuth/webhook language anywhere on this page.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { money } from "@/modules/restaurant/sales/ui/pos-types";
import {
  getMobileMoneyAccountFn,
  getMobileMoneyHealthFn,
  listMobileMoneyReconciliationFn,
  upsertMobileMoneyAccountFn,
} from "../mobilemoney.functions";
import { configureMobileMoneyProviderFn } from "../providerConnection.functions";
import { getMobileMoneyProvider, MOBILE_MONEY_PROVIDER_CODES } from "../providerRegistry";
import {
  MM_NETWORK_LABELS,
  MM_NETWORKS,
  healthLabel,
  type MobileMoneyActivationState,
  type MobileMoneyEnvironment,
  type MobileMoneyHealthStatus,
  type MobileMoneyMode,
  type MobileMoneyNetwork,
  type MobileMoneyReconciliationState,
} from "../contracts";

const HEALTH_TONE: Record<MobileMoneyHealthStatus, StatusTone> = {
  operational: "success",
  configuration_required: "neutral",
  connection_issue: "warning",
  provider_unavailable: "danger",
};

const RECON_TONE: Record<MobileMoneyReconciliationState, StatusTone> = {
  matched: "success",
  pending: "info",
  failed: "danger",
  exception: "warning",
  reversed: "neutral",
};

export function MobileMoneySettingsPanel() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id ?? "";
  const locations: any[] = useMemo(() => ws.data?.locations ?? [], [ws.data?.locations]);
  const [locationId, setLocationId] = useState<string>("");
  const activeLocationId = locationId || locations[0]?.id || "";
  const qc = useQueryClient();

  const getAccount = useServerFn(getMobileMoneyAccountFn);
  const upsertAccount = useServerFn(upsertMobileMoneyAccountFn);
  const getHealth = useServerFn(getMobileMoneyHealthFn);
  const listRecon = useServerFn(listMobileMoneyReconciliationFn);

  const accountQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.settings.account", tenantId, activeLocationId],
    queryFn: () => getAccount({ data: { tenantId, locationId: activeLocationId } }),
    enabled: Boolean(tenantId && activeLocationId),
  });
  const healthQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.settings.health", tenantId, activeLocationId],
    queryFn: () => getHealth({ data: { tenantId, locationId: activeLocationId } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });
  const reconQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.settings.recon", tenantId, activeLocationId],
    queryFn: () => listRecon({ data: { tenantId, locationId: activeLocationId, limit: 25 } }),
    enabled: Boolean(tenantId && activeLocationId),
  });

  const [form, setForm] = useState<{
    mode: MobileMoneyMode;
    network: MobileMoneyNetwork;
    merchantNumber: string;
    environment: MobileMoneyEnvironment;
    activationState: MobileMoneyActivationState;
    providerCode: string;
    credentials: Record<string, string>;
  } | null>(null);

  const effective = form ?? {
    mode: (accountQuery.data?.mode ?? "lipa_namba") as MobileMoneyMode,
    network: (accountQuery.data?.network ?? "mpesa") as MobileMoneyNetwork,
    merchantNumber: accountQuery.data?.merchant_number ?? "",
    environment: (accountQuery.data?.environment ?? "test") as MobileMoneyEnvironment,
    activationState: (accountQuery.data?.activation_state ??
      "inactive") as MobileMoneyActivationState,
    providerCode:
      accountQuery.data?.provider_code && accountQuery.data.provider_code !== "test"
        ? accountQuery.data.provider_code
        : "payin",
    credentials: {},
  };
  const isOn = effective.activationState === "active";

  const configureProvider = useServerFn(configureMobileMoneyProviderFn);
  const provider = getMobileMoneyProvider(effective.providerCode);
  const providerChanged =
    Boolean(accountQuery.data?.provider_code) &&
    effective.providerCode !== accountQuery.data?.provider_code;
  const credentialsProvided = Object.values(effective.credentials).some((v) => v.trim().length > 0);
  const credentialsConfigured = ["configured", "operational", "error"].includes(
    String(accountQuery.data?.provider_status ?? ""),
  );
  const productionBlocked =
    effective.mode === "connected" &&
    effective.environment === "production" &&
    (!provider || !provider.certified);

  const save = useAdminMutation({
    mutationFn: async (activationState: MobileMoneyActivationState) => {
      if (productionBlocked && activationState === "active") {
        throw new Error("This provider is not production-certified for LexiBite yet.");
      }

      // Create/update the outlet row first so the provider connection can be
      // bound to an authoritative account. It remains inactive until the
      // connection is successfully stored.
      await upsertAccount({
        data: {
          tenantId,
          locationId: activeLocationId,
          mode: effective.mode,
          network: effective.network,
          merchantNumber: effective.merchantNumber || "CONNECTED",
          environment: effective.environment,
          activationState: "inactive",
        },
      });

      if (effective.mode === "connected" && effective.providerCode !== "test") {
        if (providerChanged && !credentialsProvided) {
          throw new Error("Enter the new provider credentials before switching providers.");
        }
        if (credentialsProvided) {
          await configureProvider({
            data: {
              tenantId,
              locationId: activeLocationId,
              providerCode: effective.providerCode,
              credentials: effective.credentials,
            },
          });
        } else if (!credentialsConfigured) {
          throw new Error("Configure the selected payment provider before activating it.");
        }
      }

      return upsertAccount({
        data: {
          tenantId,
          locationId: activeLocationId,
          mode: effective.mode,
          network: effective.network,
          merchantNumber: effective.merchantNumber || "CONNECTED",
          environment: effective.environment,
          activationState,
        },
      });
    },
    successMessage: "Mobile Money saved.",
    onSuccess: () => {
      setForm(null);
      qc.invalidateQueries({
        queryKey: ["restaurant.mobilemoney.settings.account", tenantId, activeLocationId],
      });
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.account", tenantId] });
    },
  });

  const health = healthQuery.data as any;
  const recon: any[] = reconQuery.data ?? [];

  const locationOptions = useMemo(
    () => locations.map((l) => ({ id: l.id, name: l.name as string })),
    [locations],
  );

  if (ws.isLoading) return <LoadingState label="Loading Mobile Money…" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mobile Money"
        description="Enter your Lipa Namba, activate, and Mobile Money is on. Everything else stays behind the scenes."
      />

      <SectionCard
        title="Mobile Money"
        actions={
          locationOptions.length > 1 ? (
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={activeLocationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setForm(null);
              }}
            >
              {locationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        <div className="mb-4 flex items-center gap-3">
          <StatusChip tone={isOn ? "success" : "neutral"}>
            {isOn ? "● Mobile Money ON" : "Mobile Money OFF"}
          </StatusChip>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Choose network">
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={effective.network}
              onChange={(e) =>
                setForm({ ...effective, network: e.target.value as MobileMoneyNetwork })
              }
            >
              {MM_NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {MM_NETWORK_LABELS[n]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lipa Namba / Merchant Number">
            <Input
              value={effective.merchantNumber}
              onChange={(e) => setForm({ ...effective, merchantNumber: e.target.value })}
              placeholder="e.g. 123456"
            />
          </Field>
        </div>

        <details className="mt-4 rounded-md border p-3 text-xs text-[color:var(--os-ink-3)]">
          <summary className="cursor-pointer select-none font-medium">
            Advanced (integration)
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Mode">
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={effective.mode}
                onChange={(e) =>
                  setForm({ ...effective, mode: e.target.value as MobileMoneyMode })
                }
              >
                <option value="lipa_namba">Merchant number — staff confirm each payment</option>
                <option value="connected">Connected — automatic confirmation</option>
              </select>
            </Field>
            {effective.mode === "connected" && (
              <Field label="Environment">
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={effective.environment}
                  onChange={(e) =>
                    setForm({
                      ...effective,
                      environment: e.target.value as MobileMoneyEnvironment,
                    })
                  }
                >
                  <option value="test">Test / sandbox</option>
                  <option value="production">Production</option>
                </select>
              </Field>
            )}
          </div>

          {effective.mode === "connected" && (
            <div className="mt-4 space-y-4 rounded-md border p-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Payment provider">
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={effective.providerCode}
                    onChange={(e) =>
                      setForm({
                        ...effective,
                        providerCode: e.target.value,
                        credentials: {},
                      })
                    }
                  >
                    {MOBILE_MONEY_PROVIDER_CODES.filter((code) => code !== "test").map((code) => (
                      <option key={code} value={code}>
                        {getMobileMoneyProvider(code)?.name ?? code}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-end text-xs text-[color:var(--os-ink-3)]">
                  {provider?.implemented
                    ? provider.certified
                      ? "Connector certified."
                      : "Connector implemented; production certification is still gated."
                    : "Connector registered; adapter implementation is pending."}
                </div>
              </div>

              {provider?.implemented && (
                <div className="grid gap-4 sm:grid-cols-2">
                  {provider.credentialFields.map((field) => (
                    <Field key={field} label={field === "apiKey" ? "API key" : field === "apiSecret" ? "API secret" : "Webhook secret"}>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={effective.credentials[field] ?? ""}
                        placeholder={
                          credentialsConfigured ? "Stored securely — enter only to replace" : "Enter credential"
                        }
                        onChange={(e) =>
                          setForm({
                            ...effective,
                            credentials: { ...effective.credentials, [field]: e.target.value },
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              )}

              <p className="text-xs text-[color:var(--os-ink-3)]">
                Credentials are encrypted at rest and are never returned to the browser after saving.
                LexiBite never receives or stores the customer's mobile-money PIN.
              </p>

              {productionBlocked && (
                <p className="text-[color:var(--os-warn)]">
                  Production activation is locked until this connector passes LexiBite's provider certification gate.
                </p>
              )}
            </div>
          )}
        </details>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {isOn && (
            <Button
              variant="outline"
              disabled={!activeLocationId || save.isPending}
              onClick={() => save.mutate("inactive")}
            >
              Turn off
            </Button>
          )}
          <Button
            disabled={!activeLocationId || !effective.merchantNumber || save.isPending}
            onClick={() => save.mutate("active")}
          >
            {isOn ? "Save" : "Activate"}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Payment health" description="Read-only status for the active outlet.">
        {healthQuery.isLoading ? (
          <LoadingState label="Checking payment health…" />
        ) : (
          <div className="flex flex-wrap items-center gap-6">
            <StatusChip
              tone={health ? HEALTH_TONE[health.status as MobileMoneyHealthStatus] : "neutral"}
            >
              <ShieldCheck className="size-3" /> {health ? healthLabel(health.status) : "—"}
            </StatusChip>
            <Stat label="Paid today" value={String(health?.paidToday ?? 0)} />
            <Stat label="Pending" value={String(health?.pendingToday ?? 0)} />
            <Stat label="Failed" value={String(health?.failedToday ?? 0)} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Reconciliation"
        description="Every mobile money request at this outlet, matched against confirmed payments."
        actions={
          <Button variant="outline" size="sm" onClick={() => reconQuery.refetch()}>
            <RefreshCw className="size-3.5" />
          </Button>
        }
      >
        {reconQuery.isLoading ? (
          <LoadingState label="Loading reconciliation…" />
        ) : recon.length === 0 ? (
          <EmptyState
            title="No mobile money requests yet"
            description="Requests appear here once staff take a Mobile Money payment at this outlet."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-[color:var(--os-ink-3)]">
                <tr>
                  <th className="py-2">Reference</th>
                  <th className="py-2">Provider ref</th>
                  <th className="py-2">Amount</th>
                  <th className="py-2">State</th>
                  <th className="py-2">Reconciliation</th>
                  <th className="py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2 font-mono text-xs">{r.id.slice(0, 8)}</td>
                    <td className="py-2 font-mono text-xs">{r.provider_reference ?? "—"}</td>
                    <td className="py-2 tabular-nums">
                      {money(Number(r.amount ?? 0), r.currency ?? "TZS")}
                    </td>
                    <td className="py-2">{r.state}</td>
                    <td className="py-2">
                      <StatusChip
                        tone={
                          RECON_TONE[r.reconciliationState as MobileMoneyReconciliationState] ??
                          "neutral"
                        }
                      >
                        {r.reconciliationState}
                      </StatusChip>
                    </td>
                    <td className="py-2 text-xs text-[color:var(--os-ink-3)]">
                      {new Date(r.requested_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-[color:var(--os-ink-3)]">{label}</Label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[color:var(--os-ink-3)]">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
