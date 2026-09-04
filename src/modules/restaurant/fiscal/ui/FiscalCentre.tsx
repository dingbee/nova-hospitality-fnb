/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Fiscal / TRA Centre — the ONLY place fiscal/technical detail is ever
 * visible. Normal POS operators never see this: activation state, TIN/VRN,
 * device serial and provider status live here, gated behind fiscal.manage /
 * fiscal.view. Everywhere else (POS, customer receipt) sees only the
 * operational status strings from operatorMessageForState().
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
  getFiscalConfigurationFn,
  getFiscalHealthFn,
  getFiscalRegistrationStatusFn,
  listFiscalReceiptsFn,
  prepareZReportDraftFn,
  registerFiscalVfdFn,
  submitZReportForBusinessDateFn,
  testFiscalConnectionFn,
  upsertFiscalConfigurationFn,
} from "../fiscal.functions";
import type { FiscalActivationState, FiscalEnvironment, FiscalState } from "../contracts";

const today = () => new Date().toISOString().slice(0, 10);

const STATE_TONE: Record<FiscalState, StatusTone> = {
  not_required: "neutral",
  pending: "info",
  submitting: "info",
  accepted: "info",
  fiscalized: "success",
  rejected: "danger",
  failed: "danger",
  retry_required: "warning",
  authentication_error: "danger",
  configuration_error: "warning",
  network_error: "warning",
};

export function FiscalCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id ?? "";
  const locations: any[] = useMemo(() => ws.data?.locations ?? [], [ws.data?.locations]);
  const [locationId, setLocationId] = useState<string>("");
  const activeLocationId = locationId || locations[0]?.id || "";
  const qc = useQueryClient();

  const getConfig = useServerFn(getFiscalConfigurationFn);
  const upsertConfig = useServerFn(upsertFiscalConfigurationFn);
  const getHealth = useServerFn(getFiscalHealthFn);
  const listReceipts = useServerFn(listFiscalReceiptsFn);
  const prepareZ = useServerFn(prepareZReportDraftFn);
  const getRegistrationStatus = useServerFn(getFiscalRegistrationStatusFn);
  const registerVfd = useServerFn(registerFiscalVfdFn);
  const testConnection = useServerFn(testFiscalConnectionFn);
  const submitZReport = useServerFn(submitZReportForBusinessDateFn);

  const configQuery = useQuery({
    queryKey: ["restaurant.fiscal.config", tenantId, activeLocationId],
    queryFn: () => getConfig({ data: { tenantId, locationId: activeLocationId } }),
    enabled: Boolean(tenantId && activeLocationId),
  });
  const healthQuery = useQuery({
    queryKey: ["restaurant.fiscal.health", tenantId, activeLocationId],
    queryFn: () => getHealth({ data: { tenantId, locationId: activeLocationId } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });
  const receiptsQuery = useQuery({
    queryKey: ["restaurant.fiscal.receipts", tenantId, activeLocationId],
    queryFn: () => listReceipts({ data: { tenantId, locationId: activeLocationId, limit: 25 } }),
    enabled: Boolean(tenantId && activeLocationId),
  });
  const registrationQuery = useQuery({
    queryKey: ["restaurant.fiscal.registration", tenantId, activeLocationId],
    queryFn: () => getRegistrationStatus({ data: { tenantId, locationId: activeLocationId } }),
    enabled: Boolean(tenantId && activeLocationId),
  });

  const [form, setForm] = useState<{
    businessName: string;
    tin: string;
    vrn: string;
    environment: FiscalEnvironment;
    activationState: FiscalActivationState;
    deviceSerial: string;
  } | null>(null);

  const effective = form ?? {
    businessName: configQuery.data?.business_name ?? "",
    tin: configQuery.data?.tin ?? "",
    vrn: configQuery.data?.vrn ?? "",
    environment: (configQuery.data?.environment ?? "test") as FiscalEnvironment,
    activationState: (configQuery.data?.activation_state ?? "inactive") as FiscalActivationState,
    deviceSerial: configQuery.data?.restaurant_fiscal_devices?.[0]?.device_serial ?? "",
  };

  const saveConfig = useAdminMutation({
    mutationFn: () =>
      upsertConfig({
        data: {
          tenantId,
          locationId: activeLocationId,
          businessName: effective.businessName,
          tin: effective.tin || null,
          vrn: effective.vrn || null,
          environment: effective.environment,
          activationState: effective.activationState,
          deviceSerial: effective.deviceSerial || null,
        },
      }),
    successMessage: "Fiscal configuration saved.",
    onSuccess: () => {
      setForm(null);
      qc.invalidateQueries({ queryKey: ["restaurant.fiscal.config", tenantId, activeLocationId] });
    },
  });

  const zReport = useAdminMutation({
    mutationFn: () =>
      prepareZ({ data: { tenantId, locationId: activeLocationId, businessDate: today() } }),
    successMessage: "Z-report draft prepared.",
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["restaurant.fiscal.health", tenantId, activeLocationId] }),
  });

  const submitZ = useAdminMutation({
    mutationFn: () =>
      submitZReport({ data: { tenantId, locationId: activeLocationId, businessDate: today() } }),
    successMessage: "Z-report submitted to TRA.",
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["restaurant.fiscal.health", tenantId, activeLocationId] }),
  });

  const register = useAdminMutation({
    mutationFn: () => registerVfd({ data: { tenantId, locationId: activeLocationId } }),
    successMessage: "TRA registration completed.",
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["restaurant.fiscal.registration", tenantId, activeLocationId],
      }),
  });

  const connectionTest = useAdminMutation({
    mutationFn: () => testConnection({ data: { tenantId, locationId: activeLocationId } }),
    successMessage: "TRA connection test complete.",
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["restaurant.fiscal.registration", tenantId, activeLocationId],
      }),
  });

  const health = healthQuery.data;
  const receipts: any[] = receiptsQuery.data ?? [];
  const registration = registrationQuery.data;

  const locationOptions = useMemo(
    () => locations.map((l) => ({ id: l.id, name: l.name as string })),
    [locations],
  );

  if (ws.isLoading) return <LoadingState label="Loading fiscal configuration…" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fiscal / TRA"
        description="Taxpayer identity, fiscal device registration and receipt fiscalization status for this outlet."
      />

      <SectionCard title="Fiscal status" description="Read-only health for the active outlet.">
        {healthQuery.isLoading ? (
          <LoadingState label="Checking fiscal health…" />
        ) : (
          <div className="flex flex-wrap items-center gap-6">
            <StatusChip tone={health?.connected ? "success" : "warning"}>
              <ShieldCheck className="size-3" />{" "}
              {health?.connected ? "Certificate configured" : "Configuration required"}
            </StatusChip>
            <Stat label="Fiscalized today" value={String(health?.fiscalizedToday ?? 0)} />
            <Stat label="Pending" value={String(health?.pendingToday ?? 0)} />
            <Stat label="Rejected" value={String(health?.rejectedToday ?? 0)} />
            <Stat
              label="Last fiscalized"
              value={
                health?.lastFiscalizedAt
                  ? new Date(health.lastFiscalizedAt).toLocaleTimeString()
                  : "—"
              }
            />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Business / taxpayer"
        description="Never shown to POS operators or on the customer receipt beyond what fiscal law requires."
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name">
            <Input
              value={effective.businessName}
              onChange={(e) => setForm({ ...effective, businessName: e.target.value })}
              placeholder="Registered business name"
            />
          </Field>
          <Field label="Environment">
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={effective.environment}
              onChange={(e) =>
                setForm({ ...effective, environment: e.target.value as FiscalEnvironment })
              }
            >
              <option value="test">Test / sandbox</option>
              <option value="production">Production</option>
            </select>
          </Field>
          <Field label="TIN">
            <Input
              value={effective.tin}
              onChange={(e) => setForm({ ...effective, tin: e.target.value })}
            />
          </Field>
          <Field label="VRN">
            <Input
              value={effective.vrn}
              onChange={(e) => setForm({ ...effective, vrn: e.target.value })}
            />
          </Field>
          <Field label="Fiscal device serial">
            <Input
              value={effective.deviceSerial}
              onChange={(e) => setForm({ ...effective, deviceSerial: e.target.value })}
            />
          </Field>
          <Field label="Activation">
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={effective.activationState}
              onChange={(e) =>
                setForm({ ...effective, activationState: e.target.value as FiscalActivationState })
              }
            >
              <option value="inactive">Inactive — POS never fiscalizes</option>
              <option value="test">Test — fiscalizes via sandbox only</option>
              <option value="active">Active — fiscalizes every sale</option>
            </select>
          </Field>
        </div>
        {effective.environment === "production" && (
          <p className="mt-3 text-xs text-[color:var(--os-warn)]">
            Production requires an approved TRA/VFD provider to be configured server-side. Until
            then, sales at this outlet will show fiscal receipts as pending.
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            disabled={!activeLocationId || !effective.businessName || saveConfig.isPending}
            onClick={() => saveConfig.mutate()}
          >
            Save fiscal configuration
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="TRA registration"
        description="Registration is one-time per VFD and comes from TRA — REGID/EFDSERIAL/receipt code can never be typed in manually."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeLocationId || connectionTest.isPending}
              onClick={() => connectionTest.mutate()}
            >
              Test TRA connection
            </Button>
            <Button
              size="sm"
              disabled={!activeLocationId || register.isPending}
              onClick={() => register.mutate()}
            >
              {registration?.registered ? "Refresh TRA registration" : "Register with TRA"}
            </Button>
          </div>
        }
      >
        {registrationQuery.isLoading ? (
          <LoadingState label="Loading registration status…" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat
              label="Registration"
              value={registration?.registered ? "Registered" : "Not registered"}
            />
            <Stat label="REGID" value={registration?.regId ?? "—"} />
            <Stat label="EFD serial" value={registration?.efdSerial ?? "—"} />
            <Stat label="Receipt code" value={registration?.receiptCode ?? "—"} />
            <Stat label="Tax office" value={registration?.taxOffice ?? "—"} />
            <Stat
              label="Token"
              value={
                registration?.tokenStatus === "valid"
                  ? "Valid"
                  : registration?.tokenStatus === "expired"
                    ? "Expired — refresh required"
                    : "Not authenticated"
              }
            />
          </div>
        )}
        {connectionTest.data && (
          <p
            className={`mt-3 text-xs ${connectionTest.data.ok ? "text-[color:var(--os-success)]" : "text-[color:var(--os-warn)]"}`}
          >
            {connectionTest.data.detail}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Recent fiscal receipts"
        actions={
          <Button variant="outline" size="sm" onClick={() => receiptsQuery.refetch()}>
            <RefreshCw className="size-3.5" />
          </Button>
        }
      >
        {receiptsQuery.isLoading ? (
          <LoadingState label="Loading receipts…" />
        ) : receipts.length === 0 ? (
          <EmptyState
            title="No fiscal receipts yet"
            description="Fiscal receipts appear here once sales are fiscalized at this outlet."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-[color:var(--os-ink-3)]">
                <tr>
                  <th className="py-2">Fiscal receipt</th>
                  <th className="py-2">State</th>
                  <th className="py-2">Total</th>
                  <th className="py-2">Attempts</th>
                  <th className="py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2 font-mono text-xs">{r.fiscal_receipt_number ?? "—"}</td>
                    <td className="py-2">
                      <StatusChip tone={STATE_TONE[r.state as FiscalState] ?? "neutral"}>
                        {r.state}
                      </StatusChip>
                    </td>
                    <td className="py-2 tabular-nums">
                      {money(Number(r.total ?? 0), r.currency ?? "TZS")}
                    </td>
                    <td className="py-2 tabular-nums">{r.attempt_count}</td>
                    <td className="py-2 text-xs text-[color:var(--os-ink-3)]">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Z-report"
        description="Daily fiscal aggregation for this outlet, from LexiBite's own fiscal sales ledger."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeLocationId || zReport.isPending}
              onClick={() => zReport.mutate()}
            >
              Prepare today's draft
            </Button>
            <Button
              size="sm"
              disabled={!activeLocationId || submitZ.isPending}
              onClick={() => submitZ.mutate()}
            >
              Submit Z-report to TRA
            </Button>
          </div>
        }
      >
        {(submitZ.data ?? zReport.data) ? (
          <div className="flex flex-wrap gap-6 text-sm">
            <Stat label="Receipts" value={String((submitZ.data ?? zReport.data).receipt_count)} />
            <Stat
              label="Subtotal"
              value={money(Number((submitZ.data ?? zReport.data).subtotal), "TZS")}
            />
            <Stat
              label="Tax"
              value={money(Number((submitZ.data ?? zReport.data).tax_total), "TZS")}
            />
            <Stat
              label="Total"
              value={money(Number((submitZ.data ?? zReport.data).total), "TZS")}
            />
            <StatusChip tone={submitZ.data?.state === "acknowledged" ? "success" : "neutral"}>
              {(submitZ.data ?? zReport.data).state}
            </StatusChip>
            {submitZ.data?.zNumber != null && (
              <Stat label="ZNUMBER" value={String(submitZ.data.zNumber)} />
            )}
          </div>
        ) : (
          <p className="text-xs text-[color:var(--os-ink-3)]">No draft prepared yet today.</p>
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
