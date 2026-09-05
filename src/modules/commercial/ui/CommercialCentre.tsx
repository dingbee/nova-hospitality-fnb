/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * P01 — Commercial Administration Centre.
 *
 * Platform-level commercial policy: Plans, Capabilities, Entitlements,
 * Usage & Quotas, Pricing, Additional Properties, Founding 10, Commercial
 * Overrides, Subscriptions, Commercial Audit Log — built inside the
 * existing NovaShell/PageHeader/SectionCard admin architecture, not a
 * parallel admin app. Route-level access is enforced by every server
 * function here calling assertCommercialAdmin — this page renders for
 * anyone the nav shows it to, but every read/write independently re-checks
 * commercial admin status server-side.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Cpu, LayoutDashboard, ShieldAlert, Users } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  ENTITLEMENT_STATES,
  OVERAGE_BEHAVIORS,
  OVERRIDE_SCOPE_TYPES,
  PRICING_STATUSES,
} from "../contracts";
import {
  grantCommercialAdminFn,
  listCommercialAdministratorsFn,
  listCommercialAuditLogFn,
  listCommercialCapabilitiesFn,
  listCommercialOverridesFn,
  listCommercialPlanEntitlementsFn,
  listCommercialPlansFn,
  listCommercialPricingFn,
  listCommercialProgrammeEntitlementsFn,
  listCommercialProgrammesFn,
  listCommercialPropertyClassificationsFn,
  listCommercialPropertyPoliciesFn,
  listCommercialQuotaDefinitionsFn,
  listCommercialSubscriptionsFn,
  listCommercialTenantsFn,
  revokeCommercialAdminFn,
  revokeCommercialOverrideFn,
  upsertCommercialCapabilityFn,
  upsertCommercialOverrideFn,
  upsertCommercialPlanEntitlementFn,
  upsertCommercialPlanFn,
  upsertCommercialPricingFn,
  upsertCommercialProgrammeEntitlementFn,
  upsertCommercialProgrammeFn,
  upsertCommercialPropertyPolicyFn,
  upsertCommercialQuotaDefinitionFn,
  upsertCommercialSubscriptionFn,
  whoAmICommercialFn,
} from "../commercial.functions";
import { BillingOverviewPanel, CustomerWorkspacePanel } from "./CommercialLifecycle";
import {
  CollectionsPanel,
  CommercialOverviewPanel,
  CustomersPortfolioPanel,
  RenewalsPanel,
} from "./CommercialOperations";

const TZS = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(n) + " TZS";

function useCommercialData() {
  const fns = {
    plans: useServerFn(listCommercialPlansFn),
    capabilities: useServerFn(listCommercialCapabilitiesFn),
    programmes: useServerFn(listCommercialProgrammesFn),
    planEntitlements: useServerFn(listCommercialPlanEntitlementsFn),
    programmeEntitlements: useServerFn(listCommercialProgrammeEntitlementsFn),
    pricing: useServerFn(listCommercialPricingFn),
    propertyPolicies: useServerFn(listCommercialPropertyPoliciesFn),
    quotaDefinitions: useServerFn(listCommercialQuotaDefinitionsFn),
    overrides: useServerFn(listCommercialOverridesFn),
    subscriptions: useServerFn(listCommercialSubscriptionsFn),
    propertyClassifications: useServerFn(listCommercialPropertyClassificationsFn),
    auditLog: useServerFn(listCommercialAuditLogFn),
    administrators: useServerFn(listCommercialAdministratorsFn),
    whoAmI: useServerFn(whoAmICommercialFn),
    tenants: useServerFn(listCommercialTenantsFn),
  };
  const plans = useQuery({
    queryKey: ["commercial.plans"],
    queryFn: () => fns.plans({ data: {} }),
  });
  const capabilities = useQuery({
    queryKey: ["commercial.capabilities"],
    queryFn: () => fns.capabilities({ data: {} }),
  });
  const programmes = useQuery({
    queryKey: ["commercial.programmes"],
    queryFn: () => fns.programmes({ data: {} }),
  });
  const planEntitlements = useQuery({
    queryKey: ["commercial.planEntitlements"],
    queryFn: () => fns.planEntitlements({ data: {} }),
  });
  const programmeEntitlements = useQuery({
    queryKey: ["commercial.programmeEntitlements"],
    queryFn: () => fns.programmeEntitlements({ data: {} }),
  });
  const pricing = useQuery({
    queryKey: ["commercial.pricing"],
    queryFn: () => fns.pricing({ data: {} }),
  });
  const propertyPolicies = useQuery({
    queryKey: ["commercial.propertyPolicies"],
    queryFn: () => fns.propertyPolicies({ data: {} }),
  });
  const quotaDefinitions = useQuery({
    queryKey: ["commercial.quotaDefinitions"],
    queryFn: () => fns.quotaDefinitions({ data: {} }),
  });
  const overrides = useQuery({
    queryKey: ["commercial.overrides"],
    queryFn: () => fns.overrides({ data: {} }),
  });
  const subscriptions = useQuery({
    queryKey: ["commercial.subscriptions"],
    queryFn: () => fns.subscriptions({ data: {} }),
  });
  const propertyClassifications = useQuery({
    queryKey: ["commercial.propertyClassifications"],
    queryFn: () => fns.propertyClassifications({ data: {} }),
  });
  const auditLog = useQuery({
    queryKey: ["commercial.auditLog"],
    queryFn: () => fns.auditLog({ data: { limit: 150 } }),
  });
  const administrators = useQuery({
    queryKey: ["commercial.administrators"],
    queryFn: () => fns.administrators({ data: {} }),
  });
  const whoAmI = useQuery({
    queryKey: ["commercial.whoAmI"],
    queryFn: () => fns.whoAmI({ data: {} }),
  });
  const tenants = useQuery({
    queryKey: ["commercial.tenants"],
    queryFn: () => fns.tenants({ data: {} }),
  });

  return {
    plans,
    capabilities,
    programmes,
    planEntitlements,
    programmeEntitlements,
    pricing,
    propertyPolicies,
    quotaDefinitions,
    overrides,
    subscriptions,
    propertyClassifications,
    auditLog,
    administrators,
    whoAmI,
    tenants,
  };
}

export function CommercialCentre() {
  const qc = useQueryClient();
  const data = useCommercialData();

  const invalidate = (...keys: string[]) =>
    keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  if (data.whoAmI.isLoading) return <LoadingState />;
  if (data.whoAmI.data && !data.whoAmI.data.commercialAdmin) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Commercial Administration"
        description="This area is platform-level and restricted to commercial administrators. If you believe you should have access, ask an existing commercial administrator to grant it."
      />
    );
  }

  const loading =
    data.plans.isLoading ||
    data.capabilities.isLoading ||
    data.programmes.isLoading ||
    data.pricing.isLoading;
  if (loading) return <LoadingState />;

  const plans = data.plans.data ?? [];
  const capabilities = data.capabilities.data ?? [];
  const programmes = data.programmes.data ?? [];
  const activePlans = plans.filter((p: any) => p.status === "active").length;
  const activeCapabilities = capabilities.filter((c: any) => c.status === "active").length;
  const activeSubs = (data.subscriptions.data ?? []).filter(
    (s: any) => s.status === "active",
  ).length;
  const chargeableProperties = (data.propertyClassifications.data ?? []).filter(
    (r: any) => r.chargeable,
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Commercial Centre"
        description="Plans, capabilities, entitlements, quotas, pricing and commercial governance — read from controlled configuration, never hardcoded."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Plans"
          value={`${activePlans}/${plans.length}`}
          icon={LayoutDashboard}
          hint="active / total"
        />
        <StatCard
          label="Capabilities"
          value={`${activeCapabilities}/${capabilities.length}`}
          icon={Cpu}
          hint="active / registered"
        />
        <StatCard label="Active subscriptions" value={activeSubs} icon={Users} />
        <StatCard
          label="Chargeable properties"
          value={chargeableProperties}
          icon={Building2}
          hint="additional_chargeable classifications"
        />
      </div>

      <Tabs defaultValue="ops-overview" className="w-full">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="ops-overview">Commercial Overview</TabsTrigger>
          <TabsTrigger value="ops-customers">Customers</TabsTrigger>
          <TabsTrigger value="ops-renewals">Renewals</TabsTrigger>
          <TabsTrigger value="ops-collections">Collections</TabsTrigger>
          <TabsTrigger value="overview">Governance</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
          <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
          <TabsTrigger value="quotas">Usage &amp; Quotas</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="properties">Additional Properties</TabsTrigger>
          <TabsTrigger value="founding10">Founding 10</TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="customers">Customer Workspace</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="ops-overview">
          <CommercialOverviewPanel
            subscriptions={data.subscriptions.data ?? []}
            propertyClassifications={data.propertyClassifications.data ?? []}
          />
        </TabsContent>
        <TabsContent value="ops-customers">
          <CustomersPortfolioPanel />
        </TabsContent>
        <TabsContent value="ops-renewals">
          <RenewalsPanel plans={plans} />
        </TabsContent>
        <TabsContent value="ops-collections">
          <CollectionsPanel />
        </TabsContent>
        <TabsContent value="overview">
          <OverviewTab data={data} />
        </TabsContent>
        <TabsContent value="plans">
          <PlansTab plans={plans} onSaved={() => invalidate("commercial.plans")} />
        </TabsContent>
        <TabsContent value="capabilities">
          <CapabilitiesTab
            capabilities={capabilities}
            onSaved={() => invalidate("commercial.capabilities")}
          />
        </TabsContent>
        <TabsContent value="entitlements">
          <EntitlementsTab
            plans={plans}
            capabilities={capabilities}
            entitlements={data.planEntitlements.data ?? []}
            onSaved={() => invalidate("commercial.planEntitlements")}
          />
        </TabsContent>
        <TabsContent value="quotas">
          <QuotasTab
            quotaDefinitions={data.quotaDefinitions.data ?? []}
            plans={plans}
            capabilities={capabilities}
            onSaved={() => invalidate("commercial.quotaDefinitions")}
          />
        </TabsContent>
        <TabsContent value="pricing">
          <PricingTab
            plans={plans}
            pricing={data.pricing.data ?? []}
            onSaved={() => invalidate("commercial.pricing")}
          />
        </TabsContent>
        <TabsContent value="properties">
          <PropertiesTab
            plans={plans}
            propertyPolicies={data.propertyPolicies.data ?? []}
            classifications={data.propertyClassifications.data ?? []}
            onSaved={() => invalidate("commercial.propertyPolicies")}
          />
        </TabsContent>
        <TabsContent value="founding10">
          <Founding10Tab
            programmes={programmes}
            capabilities={capabilities}
            programmeEntitlements={data.programmeEntitlements.data ?? []}
            pricing={data.pricing.data ?? []}
            onSaved={() => invalidate("commercial.programmes", "commercial.programmeEntitlements")}
          />
        </TabsContent>
        <TabsContent value="overrides">
          <OverridesTab
            overrides={data.overrides.data ?? []}
            onSaved={() => invalidate("commercial.overrides")}
          />
        </TabsContent>
        <TabsContent value="subscriptions">
          <SubscriptionsTab
            plans={plans}
            programmes={programmes}
            subscriptions={data.subscriptions.data ?? []}
            onSaved={() => invalidate("commercial.subscriptions")}
          />
          <div className="mt-6">
            <CommercialAdminsTab
              administrators={data.administrators.data ?? []}
              onSaved={() => invalidate("commercial.administrators")}
            />
          </div>
        </TabsContent>
        <TabsContent value="billing">
          <BillingOverviewPanel subscriptions={data.subscriptions.data ?? []} />
        </TabsContent>
        <TabsContent value="customers">
          <CustomerWorkspacePanel
            tenants={data.tenants.data ?? []}
            plans={plans}
            programmes={programmes}
          />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab auditLog={data.auditLog.data ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------- Overview */

function OverviewTab({ data }: { data: ReturnType<typeof useCommercialData> }) {
  const overrideCount = (data.overrides.data ?? []).filter(
    (o: any) => o.status === "active",
  ).length;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SectionCard title="Commercial constitution" description="Fixed architectural guarantees">
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            • Exactly 3 permanent plans (CORE, PRO, ENTERPRISE) — enforced by a database constraint.
          </li>
          <li>• Founding 10 is a programme overlay on a plan, never a fourth plan.</li>
          <li>
            • Every capability access decision resolves through one server-side function — no
            scattered plan checks.
          </li>
          <li>• Pricing and quotas are configuration rows, never application constants.</li>
        </ul>
      </SectionCard>
      <SectionCard title="Governance state">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-muted-foreground">Active overrides</dt>
          <dd className="text-right font-medium">{overrideCount}</dd>
          <dt className="text-muted-foreground">Commercial administrators</dt>
          <dd className="text-right font-medium">
            {(data.administrators.data ?? []).filter((a: any) => a.status === "active").length}
          </dd>
          <dt className="text-muted-foreground">Audit entries (last 150)</dt>
          <dd className="text-right font-medium">{(data.auditLog.data ?? []).length}</dd>
        </dl>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ Plans */

function PlansTab({ plans, onSaved }: { plans: any[]; onSaved: () => void }) {
  const upsert = useServerFn(upsertCommercialPlanFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Plan updated",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Plans"
      description="Exactly three permanent plans. Codes are fixed by database constraint — only status, name, description and sort order are editable here."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sort</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p) => (
            <EditableRow
              key={p.id}
              row={p}
              onSave={(patch) => mutation.mutate({ id: p.id, code: p.code, ...patch })}
              pending={mutation.isPending}
            />
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function EditableRow({
  row,
  onSave,
  pending,
}: {
  row: any;
  onSave: (patch: {
    name: string;
    description?: string;
    status: string;
    sortOrder: number;
  }) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(row.name);
  const [status, setStatus] = useState(row.status);
  const [sortOrder, setSortOrder] = useState<number>(row.sort_order ?? 0);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs uppercase">{row.code}</TableCell>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 max-w-[200px]"
        />
      </TableCell>
      <TableCell>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="deprecated">Deprecated</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value))}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSave({ name, status, sortOrder, description: row.description ?? undefined })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------ Capabilities */

function CapabilitiesTab({ capabilities, onSaved }: { capabilities: any[]; onSaved: () => void }) {
  const upsert = useServerFn(upsertCommercialCapabilityFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Capability updated",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Capability registry"
      description="Stable identifiers for every commercially governed feature. Not every capability is customer-exposed yet — 'coming_soon' capabilities are registered but not built."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {capabilities.map((c) => (
            <CapabilityRow
              key={c.id}
              row={c}
              pending={mutation.isPending}
              onSave={(patch) =>
                mutation.mutate({
                  id: c.id,
                  code: c.code,
                  name: c.name,
                  description: c.description ?? undefined,
                  sortOrder: c.sort_order ?? 0,
                  ...patch,
                })
              }
            />
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function CapabilityRow({
  row,
  onSave,
  pending,
}: {
  row: any;
  onSave: (patch: { category: string; status: string }) => void;
  pending: boolean;
}) {
  const [category, setCategory] = useState(row.category);
  const [status, setStatus] = useState(row.status);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.code}</TableCell>
      <TableCell>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-8 w-40"
        />
      </TableCell>
      <TableCell>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="coming_soon">Coming soon</SelectItem>
            <SelectItem value="deprecated">Deprecated</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Button size="sm" disabled={pending} onClick={() => onSave({ category, status })}>
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------ Entitlements */

function EntitlementsTab({
  plans,
  capabilities,
  entitlements,
  onSaved,
}: {
  plans: any[];
  capabilities: any[];
  entitlements: any[];
  onSaved: () => void;
}) {
  const upsert = useServerFn(upsertCommercialPlanEntitlementFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Entitlement updated",
    onSuccess: onSaved,
  });
  const byKey = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of entitlements) m.set(`${e.plan_id}:${e.capability_id}`, e);
    return m;
  }, [entitlements]);

  return (
    <SectionCard
      title="Plan entitlements"
      description="Which state each capability has on each plan. No plan/capability combination not shown here is silently 'included' — a missing row resolves to unavailable."
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Capability</TableHead>
              {plans.map((p) => (
                <TableHead key={p.id} className="uppercase">
                  {p.code}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {capabilities.map((cap) => (
              <TableRow key={cap.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs">{cap.code}</TableCell>
                {plans.map((plan) => {
                  const existing = byKey.get(`${plan.id}:${cap.id}`);
                  return (
                    <TableCell key={plan.id}>
                      <Select
                        value={existing?.state ?? "unavailable"}
                        onValueChange={(state) =>
                          mutation.mutate({
                            id: existing?.id,
                            planId: plan.id,
                            capabilityId: cap.id,
                            state,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-[140px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ENTITLEMENT_STATES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ Quotas */

function QuotasTab({
  quotaDefinitions,
  plans,
  capabilities,
  onSaved,
}: {
  quotaDefinitions: any[];
  plans: any[];
  capabilities: any[];
  onSaved: () => void;
}) {
  const upsert = useServerFn(upsertCommercialQuotaDefinitionFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Quota updated",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Usage quota definitions"
      description="Thresholds and overage policy are admin-configured — never hardcoded percentages."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Limit / period</TableHead>
            <TableHead>Warn %</TableHead>
            <TableHead>Near-limit %</TableHead>
            <TableHead>Overage behavior</TableHead>
            <TableHead>Active</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotaDefinitions.map((q) => (
            <QuotaRow
              key={q.id}
              row={q}
              capabilities={capabilities}
              plans={plans}
              pending={mutation.isPending}
              onSave={(patch) =>
                mutation.mutate({
                  id: q.id,
                  code: q.code,
                  capabilityId: q.capability_id ?? undefined,
                  planId: q.plan_id ?? undefined,
                  programmeId: q.programme_id ?? undefined,
                  unit: q.unit,
                  period: q.period,
                  scope: q.scope,
                  ...patch,
                })
              }
            />
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function QuotaRow({
  row,
  onSave,
  pending,
}: {
  row: any;
  capabilities: any[];
  plans: any[];
  onSave: (patch: {
    limitValue: number;
    warningThresholdPct: number;
    nearLimitThresholdPct: number;
    overageBehavior: string;
    active: boolean;
  }) => void;
  pending: boolean;
}) {
  const [limitValue, setLimitValue] = useState<number>(Number(row.limit_value));
  const [warn, setWarn] = useState<number>(Number(row.warning_threshold_pct));
  const [near, setNear] = useState<number>(Number(row.near_limit_threshold_pct));
  const [overage, setOverage] = useState<string>(row.overage_behavior);
  const [active, setActive] = useState<boolean>(row.active);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.code}</TableCell>
      <TableCell className="uppercase text-xs text-muted-foreground">
        {row.commercial_plans?.code ?? "any"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={limitValue}
            onChange={(e) => setLimitValue(Number(e.target.value))}
            className="h-8 w-24"
          />
          <span className="text-xs text-muted-foreground">
            {row.unit}/{row.period}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          value={warn}
          onChange={(e) => setWarn(Number(e.target.value))}
          className="h-8 w-16"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          value={near}
          onChange={(e) => setNear(Number(e.target.value))}
          className="h-8 w-16"
        />
      </TableCell>
      <TableCell>
        <Select value={overage} onValueChange={setOverage}>
          <SelectTrigger className="h-8 w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OVERAGE_BEHAVIORS.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Switch checked={active} onCheckedChange={setActive} />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSave({
              limitValue,
              warningThresholdPct: warn,
              nearLimitThresholdPct: near,
              overageBehavior: overage,
              active,
            })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ----------------------------------------------------------------- Pricing */

function PricingTab({
  plans,
  pricing,
  onSaved,
}: {
  plans: any[];
  pricing: any[];
  onSaved: () => void;
}) {
  const upsert = useServerFn(upsertCommercialPricingFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Pricing updated",
    onSuccess: onSaved,
  });
  const baseline = pricing.filter((p: any) => !p.programme_id);
  return (
    <SectionCard
      title="Pricing"
      description="Seed/configuration values, editable without a code deployment. Amounts shown in TZS as configured."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead>Monthly</TableHead>
            <TableHead>Annual</TableHead>
            <TableHead>Additional property</TableHead>
            <TableHead>Implementation fee</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {baseline.map((row: any) => (
            <PricingRow
              key={row.id}
              row={row}
              pending={mutation.isPending}
              onSave={(patch) =>
                mutation.mutate({
                  id: row.id,
                  planId: row.plan_id,
                  currency: row.currency,
                  ...patch,
                })
              }
            />
          ))}
        </TableBody>
      </Table>
      <p className="mt-4 text-xs text-muted-foreground">
        Current values —{" "}
        {baseline
          .map((r: any) => `${r.commercial_plans?.code?.toUpperCase()}: ${TZS(r.monthly_price)}/mo`)
          .join(" · ")}
      </p>
    </SectionCard>
  );
}

function PricingRow({
  row,
  onSave,
  pending,
}: {
  row: any;
  onSave: (patch: {
    monthlyPrice?: number;
    annualPrice?: number;
    additionalPropertyPrice?: number;
    implementationFee?: number;
    status: string;
    billingInterval: string;
    taxTreatment: string;
    trialDays: number;
  }) => void;
  pending: boolean;
}) {
  const [monthly, setMonthly] = useState<string>(row.monthly_price ?? "");
  const [annual, setAnnual] = useState<string>(row.annual_price ?? "");
  const [addl, setAddl] = useState<string>(row.additional_property_price ?? "");
  const [impl, setImpl] = useState<string>(row.implementation_fee ?? "");
  const [status, setStatus] = useState(row.status);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs uppercase">{row.commercial_plans?.code}</TableCell>
      <TableCell>
        <Input value={monthly} onChange={(e) => setMonthly(e.target.value)} className="h-8 w-28" />
      </TableCell>
      <TableCell>
        <Input value={annual} onChange={(e) => setAnnual(e.target.value)} className="h-8 w-28" />
      </TableCell>
      <TableCell>
        <Input value={addl} onChange={(e) => setAddl(e.target.value)} className="h-8 w-28" />
      </TableCell>
      <TableCell>
        <Input value={impl} onChange={(e) => setImpl(e.target.value)} className="h-8 w-28" />
      </TableCell>
      <TableCell>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRICING_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSave({
              monthlyPrice: monthly === "" ? undefined : Number(monthly),
              annualPrice: annual === "" ? undefined : Number(annual),
              additionalPropertyPrice: addl === "" ? undefined : Number(addl),
              implementationFee: impl === "" ? undefined : Number(impl),
              status,
              billingInterval: row.billing_interval,
              taxTreatment: row.tax_treatment,
              trialDays: row.trial_days ?? 0,
            })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------- Properties */

function PropertiesTab({
  plans,
  propertyPolicies,
  classifications,
  onSaved,
}: {
  plans: any[];
  propertyPolicies: any[];
  classifications: any[];
  onSaved: () => void;
}) {
  const upsert = useServerFn(upsertCommercialPropertyPolicyFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Property policy updated",
    onSuccess: onSaved,
  });
  const baseline = propertyPolicies.filter((p: any) => !p.programme_id);
  return (
    <div className="space-y-6">
      <SectionCard
        title="Additional-property policy"
        description="Included property count, additional-property price and approval threshold, per plan. An outlet within a property never counts here — only properties do."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Included properties</TableHead>
              <TableHead>Additional price</TableHead>
              <TableHead>Approval above</TableHead>
              <TableHead>Enterprise treatment</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {baseline.map((row: any) => (
              <PropertyPolicyRow
                key={row.id}
                row={row}
                pending={mutation.isPending}
                onSave={(patch) =>
                  mutation.mutate({ id: row.id, planId: row.plan_id, status: "active", ...patch })
                }
              />
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      <SectionCard
        title="Property commercial classifications"
        description="One immutable decision per property, recorded automatically the moment it is added. A chargeable additional property is never silently activated."
      >
        {classifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No properties have been classified yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Property</TableHead>
                <TableHead>#</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead>Chargeable</TableHead>
                <TableHead>Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classifications.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell>{c.restaurant_tenants?.name ?? "—"}</TableCell>
                  <TableCell>{c.restaurant_properties?.name ?? "—"}</TableCell>
                  <TableCell>{c.property_sequence}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.classification}</Badge>
                  </TableCell>
                  <TableCell>{c.chargeable ? "Yes" : "No"}</TableCell>
                  <TableCell>{c.chargeable ? TZS(c.price_applied) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

function PropertyPolicyRow({
  row,
  onSave,
  pending,
}: {
  row: any;
  onSave: (patch: {
    includedProperties: number;
    additionalPropertyPrice?: number;
    requiresApprovalAbove?: number;
    enterpriseTreatment: boolean;
  }) => void;
  pending: boolean;
}) {
  const [included, setIncluded] = useState<number>(row.included_properties ?? 1);
  const [addl, setAddl] = useState<string>(row.additional_property_price ?? "");
  const [approvalAbove, setApprovalAbove] = useState<string>(row.requires_approval_above ?? "");
  const [enterprise, setEnterprise] = useState<boolean>(row.enterprise_treatment);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs uppercase">{row.commercial_plans?.code}</TableCell>
      <TableCell>
        <Input
          type="number"
          value={included}
          onChange={(e) => setIncluded(Number(e.target.value))}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Input value={addl} onChange={(e) => setAddl(e.target.value)} className="h-8 w-28" />
      </TableCell>
      <TableCell>
        <Input
          value={approvalAbove}
          onChange={(e) => setApprovalAbove(e.target.value)}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Switch checked={enterprise} onCheckedChange={setEnterprise} />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSave({
              includedProperties: included,
              additionalPropertyPrice: addl === "" ? undefined : Number(addl),
              requiresApprovalAbove: approvalAbove === "" ? undefined : Number(approvalAbove),
              enterpriseTreatment: enterprise,
            })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------- Founding10 */

function Founding10Tab({
  programmes,
  capabilities,
  programmeEntitlements,
  pricing,
  onSaved,
}: {
  programmes: any[];
  capabilities: any[];
  programmeEntitlements: any[];
  pricing: any[];
  onSaved: () => void;
}) {
  const upsertProgramme = useServerFn(upsertCommercialProgrammeFn);
  const upsertEntitlement = useServerFn(upsertCommercialProgrammeEntitlementFn);
  const programmeMutation = useAdminMutation({
    mutationFn: (vars: any) => upsertProgramme({ data: vars }),
    successMessage: "Programme updated",
    onSuccess: onSaved,
  });
  const entitlementMutation = useAdminMutation({
    mutationFn: (vars: any) => upsertEntitlement({ data: vars }),
    successMessage: "Programme entitlement updated",
    onSuccess: onSaved,
  });

  const founding10 = programmes.find((p: any) => p.code === "founding_10");
  const overlayPricing = pricing.filter((p: any) => p.programme_id === founding10?.id);
  const byCapability = new Map(programmeEntitlements.map((e: any) => [e.capability_id, e]));

  if (!founding10)
    return <p className="text-sm text-muted-foreground">Founding 10 programme not seeded.</p>;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Founding 10 — programme, not a plan"
        description="A subscription carries plan = PRO/CORE/ENTERPRISE and, separately, programme = FOUNDING_10. This never creates a fourth plan."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select
              value={founding10.status}
              onValueChange={(status) =>
                programmeMutation.mutate({
                  id: founding10.id,
                  code: founding10.code,
                  name: founding10.name,
                  status,
                })
              }
            >
              <SelectTrigger className="mt-1 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="ended">Ended</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Contract reference</Label>
            <Input
              defaultValue={founding10.contract_reference ?? ""}
              className="mt-1 h-9"
              disabled
            />
          </div>
        </div>
        {overlayPricing.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            Programme pricing override on record for{" "}
            {overlayPricing.map((p: any) => TZS(p.monthly_price)).join(", ")}/mo.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Founding 10 entitlement overlay"
        description="Where a row exists here, it overrides the plan's baseline entitlement for that capability — otherwise the plan baseline applies unchanged."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Capability</TableHead>
              <TableHead>Overlay state</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {capabilities
              .filter((c: any) => c.status === "active")
              .map((cap: any) => {
                const existing = byCapability.get(cap.id);
                return (
                  <TableRow key={cap.id}>
                    <TableCell className="font-mono text-xs">{cap.code}</TableCell>
                    <TableCell>
                      <Select
                        value={existing?.state ?? "__none__"}
                        onValueChange={(state) =>
                          entitlementMutation.mutate({
                            id: existing?.id,
                            programmeId: founding10.id,
                            capabilityId: cap.id,
                            state,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-[160px]">
                          <SelectValue placeholder="No overlay" />
                        </SelectTrigger>
                        <SelectContent>
                          {ENTITLEMENT_STATES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------- Overrides */

function OverridesTab({ overrides, onSaved }: { overrides: any[]; onSaved: () => void }) {
  const upsert = useServerFn(upsertCommercialOverrideFn);
  const revoke = useServerFn(revokeCommercialOverrideFn);
  const [form, setForm] = useState({
    scopeType: "tenant",
    scopeId: "",
    tenantId: "",
    overrideType: "",
    reason: "",
  });
  const createMutation = useAdminMutation({
    mutationFn: () =>
      upsert({
        data: {
          scopeType: form.scopeType as any,
          scopeId: form.scopeId || undefined,
          tenantId: form.tenantId || undefined,
          overrideType: form.overrideType,
          reason: form.reason,
        },
      }),
    successMessage: "Override created",
    onSuccess: () => {
      onSaved();
      setForm({ scopeType: "tenant", scopeId: "", tenantId: "", overrideType: "", reason: "" });
    },
  });
  const revokeMutation = useAdminMutation({
    mutationFn: (id: string) => revoke({ data: { id, reason: "Revoked from Commercial Centre" } }),
    successMessage: "Override revoked",
    onSuccess: onSaved,
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="New commercial override"
        description="Every override requires a reason and is fully audited — there are no silent commercial exceptions."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label className="text-xs">Scope type</Label>
            <Select
              value={form.scopeType}
              onValueChange={(v) => setForm((f) => ({ ...f, scopeType: v }))}
            >
              <SelectTrigger className="mt-1 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERRIDE_SCOPE_TYPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Tenant ID (optional)</Label>
            <Input
              className="mt-1 h-9"
              value={form.tenantId}
              onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))}
            />
          </div>
          <div>
            <Label className="text-xs">Scope ID (optional)</Label>
            <Input
              className="mt-1 h-9"
              value={form.scopeId}
              onChange={(e) => setForm((f) => ({ ...f, scopeId: e.target.value }))}
            />
          </div>
          <div>
            <Label className="text-xs">Override type</Label>
            <Input
              className="mt-1 h-9"
              placeholder="e.g. entitlement, price_override"
              value={form.overrideType}
              onChange={(e) => setForm((f) => ({ ...f, overrideType: e.target.value }))}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Label className="text-xs">Reason (required)</Label>
            <Input
              className="mt-1 h-9"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
        </div>
        <Button
          className="mt-4"
          disabled={
            createMutation.isPending || form.reason.length < 5 || form.overrideType.length < 2
          }
          onClick={() => createMutation.mutate()}
        >
          Create override
        </Button>
      </SectionCard>

      <SectionCard title="Overrides">
        {overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">No overrides recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {overrides.map((o: any) => (
                <TableRow key={o.id}>
                  <TableCell className="text-xs">{o.scope_type}</TableCell>
                  <TableCell className="text-xs">{o.override_type}</TableCell>
                  <TableCell>
                    <Badge variant={o.status === "active" ? "default" : "outline"}>
                      {o.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(o.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {o.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(o.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

/* --------------------------------------------------------- Subscriptions */

function SubscriptionsTab({
  plans,
  programmes,
  subscriptions,
  onSaved,
}: {
  plans: any[];
  programmes: any[];
  subscriptions: any[];
  onSaved: () => void;
}) {
  const upsert = useServerFn(upsertCommercialSubscriptionFn);
  const mutation = useAdminMutation({
    mutationFn: (vars: any) => upsert({ data: vars }),
    successMessage: "Subscription updated",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Subscriptions"
      description="A tenant with no row here defaults to CORE, active — every part of the commercial engine treats that identically to an explicit CORE subscription."
    >
      {subscriptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tenant has an explicit subscription assigned yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Programme</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((s: any) => (
              <SubscriptionRow
                key={s.id}
                row={s}
                plans={plans}
                programmes={programmes}
                pending={mutation.isPending}
                onSave={(patch) => mutation.mutate({ tenantId: s.tenant_id, ...patch })}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function SubscriptionRow({
  row,
  plans,
  programmes,
  onSave,
  pending,
}: {
  row: any;
  plans: any[];
  programmes: any[];
  onSave: (patch: {
    planId: string;
    programmeId?: string | null;
    billingInterval: string;
    status: string;
    reason: string;
  }) => void;
  pending: boolean;
}) {
  const [planId, setPlanId] = useState<string>(row.plan_id ?? plans[0]?.id);
  const [programmeId, setProgrammeId] = useState<string>(row.programme_id ?? "__none__");
  const [billing, setBilling] = useState<string>(row.billing_interval ?? "monthly");
  const [status, setStatus] = useState<string>(row.status ?? "active");
  return (
    <TableRow>
      <TableCell>{row.restaurant_tenants?.name ?? row.tenant_id}</TableCell>
      <TableCell>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger className="h-8 w-[130px]">
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
      </TableCell>
      <TableCell>
        <Select value={programmeId} onValueChange={setProgrammeId}>
          <SelectTrigger className="h-8 w-[150px]">
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
      </TableCell>
      <TableCell>
        <Select value={billing} onValueChange={setBilling}>
          <SelectTrigger className="h-8 w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="annual">Annual</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-24" />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSave({
              planId,
              programmeId: programmeId === "__none__" ? null : programmeId,
              billingInterval: billing,
              status,
              reason: "Updated from Commercial Centre",
            })
          }
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CommercialAdminsTab({
  administrators,
  onSaved,
}: {
  administrators: any[];
  onSaved: () => void;
}) {
  const grant = useServerFn(grantCommercialAdminFn);
  const revoke = useServerFn(revokeCommercialAdminFn);
  const [userId, setUserId] = useState("");
  const grantMutation = useAdminMutation({
    mutationFn: () => grant({ data: { userId } }),
    successMessage: "Commercial admin granted",
    onSuccess: () => {
      onSaved();
      setUserId("");
    },
  });
  const revokeMutation = useAdminMutation({
    mutationFn: (id: string) => revoke({ data: { userId: id } }),
    successMessage: "Commercial admin revoked",
    onSuccess: onSaved,
  });
  return (
    <SectionCard
      title="Commercial administrators"
      description="Platform-level allow-list, independent of tenant roles. A tenant OWNER never appears here automatically."
    >
      <div className="mb-4 flex gap-2">
        <Input
          placeholder="User ID (uuid)"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="h-9 max-w-sm"
        />
        <Button
          disabled={grantMutation.isPending || userId.length < 10}
          onClick={() => grantMutation.mutate()}
        >
          Grant
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Granted</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {administrators.map((a: any) => (
            <TableRow key={a.id}>
              <TableCell className="font-mono text-xs">{a.user_id}</TableCell>
              <TableCell>
                <Badge variant={a.status === "active" ? "default" : "outline"}>{a.status}</Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(a.granted_at).toLocaleDateString()}
              </TableCell>
              <TableCell>
                {a.status === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(a.user_id)}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/* -------------------------------------------------------------- Audit log */

function AuditTab({ auditLog }: { auditLog: any[] }) {
  return (
    <SectionCard
      title="Commercial audit log"
      description="Every material commercial configuration change: actor, action, entity, before/after, reason, timestamp."
    >
      {auditLog.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commercial audit entries yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auditLog.map((row: any) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(row.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-xs">{row.action}</TableCell>
                <TableCell className="text-xs">{row.entity_type}</TableCell>
                <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                  {row.reason ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
