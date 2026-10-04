/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
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
  getMobileMoneyHealthFn,
  listMobileMoneyReconciliationFn,
} from "../mobilemoney.functions";
import {
  configureMobileMoneyTenantProviderFn,
  getMobileMoneyTenantProviderConnectionFn,
  testMobileMoneyTenantProviderConnectionFn,
} from "../providerConnection.functions";
import { getMobileMoneyProvider, MOBILE_MONEY_PROVIDER_CODES } from "../providerRegistry";
import {
  MM_NETWORK_LABELS,
  MM_NETWORKS,
  healthLabel,
  type MobileMoneyEnvironment,
  type MobileMoneyHealthStatus,
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
  const qc = useQueryClient();

  const getConnection = useServerFn(getMobileMoneyTenantProviderConnectionFn);
  const configureConnection = useServerFn(configureMobileMoneyTenantProviderFn);
  const testConnection = useServerFn(testMobileMoneyTenantProviderConnectionFn);
  const getHealth = useServerFn(getMobileMoneyHealthFn);
  const listRecon = useServerFn(listMobileMoneyReconciliationFn);

  const connectionQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.tenant-provider", tenantId],
    queryFn: () => getConnection({ data: { tenantId } }),
    enabled: Boolean(tenantId),
  });

  const healthQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.settings.health", tenantId],
    queryFn: () => getHealth({ data: { tenantId } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const reconQuery = useQuery({
    queryKey: ["restaurant.mobilemoney.settings.recon", tenantId],
    queryFn: () => listRecon({ data: { tenantId, limit: 50 } }),
    enabled: Boolean(tenantId),
  });

  const saved = connectionQuery.data;
  const [providerCode, setProviderCode] = useState("payin");
  const [environment, setEnvironment] = useState<MobileMoneyEnvironment>("production");
  const [enabledNetworks, setEnabledNetworks] = useState<MobileMoneyNetwork[]>([
    "mpesa",
    "airtel_money",
    "mixx_yas",
    "halopesa",
  ]);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [testResult, setTestResult] = useState<"connected" | "failed" | null>(null);

  useEffect(() => {
    if (!saved || dirty) return;
    setProviderCode(saved.providerCode);
    setEnvironment(saved.environment);
    setEnabledNetworks(saved.enabledNetworks);
    setCredentials({});
    setTestResult(saved.providerStatus === "operational" ? "connected" : null);
  }, [saved, dirty]);

  const provider = getMobileMoneyProvider(providerCode);
  const credentialConfigured = Boolean(saved?.credentialsConfigured);
  const productionBlocked = environment === "production" && (!provider || !provider.certified);

  const save = useAdminMutation({
    mutationFn: async () => {
      if (productionBlocked) {
        throw new Error("This provider is not production-certified for LexiBite yet.");
      }
      const result = await configureConnection({
        data: {
          tenantId,
          providerCode,
          environment,
          enabledNetworks,
          credentials: Object.keys(credentials).length ? credentials : undefined,
        },
      });
      return result;
    },
    successMessage: "Mobile Money provider saved.",
    onSuccess: () => {
      setDirty(false);
      setCredentials({});
      setTestResult(null);
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.tenant-provider", tenantId] });
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.settings.health", tenantId] });
    },
  });

  const test = useAdminMutation({
    mutationFn: () => testConnection({ data: { tenantId } }),
    successMessage: "Mobile Money provider connected.",
    onSuccess: () => {
      setTestResult("connected");
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.tenant-provider", tenantId] });
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.settings.health", tenantId] });
    },
    onError: () => setTestResult("failed"),
  });

  const health = healthQuery.data as any;
  const recon: any[] = reconQuery.data ?? [];

  const toggleNetwork = (network: MobileMoneyNetwork) => {
    setDirty(true);
    setTestResult(null);
    setEnabledNetworks((current) =>
      current.includes(network)
        ? current.filter((n) => n !== network)
        : [...current, network],
    );
  };

  const statusConnected =
    testResult === "connected" ||
    saved?.providerStatus === "operational";

  const providerCredentialFields = provider?.credentialFields ?? [];

  const networkOptions = useMemo(
    () => MM_NETWORKS.filter((network) => provider?.supportedNetworks.includes(network)),
    [provider],
  );

  if (ws.isLoading) return <LoadingState label="Loading Mobile Money…" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mobile Money"
        description="Connect the payment provider for this restaurant tenant. The connection is shared across its outlets."
      />

      <SectionCard
        title="Mobile Money"
        description="Tenant-level provider connection"
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider">
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={providerCode}
                onChange={(e) => {
                  setProviderCode(e.target.value);
                  setCredentials({});
                  setDirty(true);
                  setTestResult(null);
                }}
              >
                {MOBILE_MONEY_PROVIDER_CODES.filter((code) => code !== "test").map((code) => (
                  <option key={code} value={code}>
                    {getMobileMoneyProvider(code)?.name ?? code}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Environment">
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={environment}
                onChange={(e) => {
                  setEnvironment(e.target.value as MobileMoneyEnvironment);
                  setDirty(true);
                  setTestResult(null);
                }}
              >
                <option value="test">Test / sandbox</option>
                <option value="production">Production</option>
              </select>
            </Field>
          </div>

          <div>
            <Label className="text-xs text-[color:var(--os-ink-3)]">Networks</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {networkOptions.map((network) => {
                const checked = enabledNetworks.includes(network);
                return (
                  <label
                    key={network}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleNetwork(network)}
                    />
                    <span>{MM_NETWORK_LABELS[network]}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {provider?.implemented ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {providerCredentialFields.map((field) => (
                <Field
                  key={field}
                  label={
                    field === "apiKey"
                      ? "API Key"
                      : field === "apiSecret"
                        ? "API Secret"
                        : "Webhook Secret"
                  }
                >
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={credentials[field] ?? ""}
                    placeholder={
                      credentialConfigured
                        ? "••••••••••••••  Stored securely"
                        : "Enter credential"
                    }
                    onChange={(e) => {
                      setCredentials((current) => ({
                        ...current,
                        [field]: e.target.value,
                      }));
                      setDirty(true);
                      setTestResult(null);
                    }}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <div className="rounded-md border p-3 text-sm text-[color:var(--os-ink-3)]">
              {provider?.name ?? providerCode} is registered but its connector is not yet implemented.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex items-center gap-2">
              <StatusChip tone={statusConnected ? "success" : "neutral"}>
                {statusConnected ? (
                  <>
                    <CheckCircle2 className="size-3.5" /> Connected
                  </>
                ) : (
                  "Not connected"
                )}
              </StatusChip>
              {saved?.providerStatus === "configured" && !statusConnected && (
                <span className="text-xs text-[color:var(--os-ink-3)]">
                  Configuration saved. Test the connection.
                </span>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={
                  !tenantId ||
                  !provider?.implemented ||
                  !credentialConfigured ||
                  test.isPending
                }
                onClick={() => test.mutate()}
              >
                <Wifi className="size-3.5" />
                Test Connection
              </Button>
              <Button
                disabled={
                  !tenantId ||
                  !provider?.implemented ||
                  enabledNetworks.length === 0 ||
                  productionBlocked ||
                  save.isPending
                }
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            </div>
          </div>

          {testResult === "failed" && (
            <p className="text-sm text-[color:var(--os-danger)]">
              Connection test failed. Check the provider credentials and environment.
            </p>
          )}

          {productionBlocked && (
            <p className="text-sm text-[color:var(--os-warn)]">
              Production activation is locked until this provider passes LexiBite's certification gate.
            </p>
          )}

          <p className="text-xs text-[color:var(--os-ink-3)]">
            Provider credentials are tenant-level, encrypted at rest, and never returned to the browser.
            LexiBite never receives or stores a customer's mobile-money PIN.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Payment health" description="Read-only status across this tenant's outlets.">
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
        description="Mobile Money requests across the tenant, matched against confirmed payments."
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
            description="Requests appear here once a Mobile Money payment is initiated."
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
