import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, ShieldCheck, Wifi } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  listIntegrationsFn,
  registerIntegrationFn,
  updateIntegrationFn,
} from "@/modules/api-platform/admin.functions";
import { testPesapalIntegrationFn } from "../pesapal-admin.functions";

type Property = { id: string; name: string };
type Integration = {
  id: string;
  provider: string;
  integration_type: string;
  property_id: string | null;
  label: string;
  status: "active" | "disabled";
  config: Record<string, unknown>;
};

export function PesapalSettingsPanel() {
  const workspace = useRestaurantWorkspace();
  const tenantId = workspace.data?.tenant?.id ?? "";
  const properties = (workspace.data?.properties ?? []) as Property[];
  const queryClient = useQueryClient();
  const list = useServerFn(listIntegrationsFn);
  const register = useServerFn(registerIntegrationFn);
  const update = useServerFn(updateIntegrationFn);
  const test = useServerFn(testPesapalIntegrationFn);

  const integrationsQuery = useQuery({
    queryKey: ["api-integrations", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => list({ data: { tenantId } }),
  });

  const [propertyId, setPropertyId] = useState("");
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [label, setLabel] = useState("Pesapal online payments");
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (!propertyId && properties.length) setPropertyId(properties[0].id);
  }, [propertyId, properties]);

  const integrations = (integrationsQuery.data ?? []) as Integration[];
  const integration = useMemo(
    () =>
      integrations.find(
        (item) =>
          item.provider === "pesapal" &&
          item.integration_type === "payment" &&
          item.property_id === propertyId,
      ) ?? null,
    [integrations, propertyId],
  );

  useEffect(() => {
    if (!integration) {
      setEnvironment("sandbox");
      setLabel("Pesapal online payments");
      return;
    }
    setEnvironment(integration.config?.environment === "production" ? "production" : "sandbox");
    setLabel(integration.label);
    setConsumerKey("");
    setConsumerSecret("");
    setTested(false);
  }, [integration?.id, integration?.config?.environment, integration?.label]);

  const refresh = () => {
    setConsumerKey("");
    setConsumerSecret("");
    setTested(false);
    queryClient.invalidateQueries({ queryKey: ["api-integrations", tenantId] });
  };

  const saveMutation = useAdminMutation({
    mutationFn: async () => {
      if (!tenantId || !propertyId) throw new Error("Select a property before configuring Pesapal.");
      if (!consumerKey.trim() || !consumerSecret.trim()) {
        throw new Error("Enter both the Pesapal Consumer Key and Consumer Secret.");
      }
      const secret = JSON.stringify({
        consumerKey: consumerKey.trim(),
        consumerSecret: consumerSecret.trim(),
      });
      const config = { environment };
      if (integration) {
        return update({
          data: {
            tenantId,
            integrationId: integration.id,
            propertyId,
            label: label.trim(),
            config,
            secret,
            status: "active",
          },
        });
      }
      return register({
        data: {
          tenantId,
          propertyId,
          provider: "pesapal",
          integrationType: "payment",
          label: label.trim(),
          config,
          secret,
        },
      });
    },
    successMessage: "Property Pesapal integration saved securely.",
    onSuccess: refresh,
  });

  const testMutation = useAdminMutation({
    mutationFn: () => test({ data: { tenantId, propertyId } }),
    successMessage: "Pesapal credentials verified for this property.",
    onSuccess: () => setTested(true),
    onError: () => setTested(false),
  });

  if (workspace.isLoading || integrationsQuery.isLoading) {
    return <div className="p-5 text-sm text-muted-foreground">Loading property payment integrations…</div>;
  }
  if (!workspace.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="Join a Restaurant & Bar OS tenant to configure property payments." />;
  }
  const canManage = Boolean(
    workspace.data.platformAdmin ||
      workspace.data.roles?.some((role: string) => role === "owner" || role === "general_manager"),
  );

  return (
    <SectionCard
      title="Pesapal — Online Payments"
      description="Configure hosted card and mobile-money checkout separately for each property. Credentials are encrypted in the Integration Registry."
    >
      {!properties.length ? (
        <EmptyState title="No properties configured" description="Create a property before connecting its payment provider." />
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-[color:var(--os-info)]/30 bg-[color:var(--os-info)]/5 px-3 py-2 text-xs text-[color:var(--os-ink-2)]">
            Each property has its own Pesapal credentials and environment. LexiBite never reads global PESAPAL_* environment variables and never falls back to another property's integration.
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Property</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={propertyId}
                onChange={(event) => {
                  setPropertyId(event.target.value);
                  setConsumerKey("");
                  setConsumerSecret("");
                  setTested(false);
                }}
                disabled={!canManage}
              >
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>{property.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Environment</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={environment}
                onChange={(event) => {
                  setEnvironment(event.target.value as "sandbox" | "production");
                  setTested(false);
                }}
                disabled={!canManage}
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Connection label</Label>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} disabled={!canManage} maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label>Pesapal Consumer Key</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={consumerKey}
                onChange={(event) => { setConsumerKey(event.target.value); setTested(false); }}
                placeholder={integration ? "Enter a new key to rotate the stored credential" : "Enter property Consumer Key"}
                disabled={!canManage}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Pesapal Consumer Secret</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={consumerSecret}
                onChange={(event) => { setConsumerSecret(event.target.value); setTested(false); }}
                placeholder={integration ? "Enter a new secret to rotate the stored credential" : "Enter property Consumer Secret"}
                disabled={!canManage}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              {integration ? (
                <Badge variant={integration.status === "active" ? "default" : "secondary"}>
                  {integration.status}
                </Badge>
              ) : (
                <Badge variant="outline">Not configured</Badge>
              )}
              {tested ? <Badge variant="default"><CheckCircle2 className="mr-1 size-3" />Credentials verified</Badge> : null}
            </div>
            {canManage ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={!integration || integration.status !== "active" || testMutation.isPending}
                  onClick={() => testMutation.mutate()}
                >
                  {testMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wifi className="mr-2 size-4" />}
                  Test credentials
                </Button>
                <Button
                  disabled={saveMutation.isPending || !propertyId || !consumerKey.trim() || !consumerSecret.trim() || !label.trim()}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                  {integration ? "Update credentials" : "Connect property"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Only property-authorized owners and general managers can manage payment credentials.</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving encrypts the credentials server-side. The browser never receives the stored secret. The IPN endpoint is registered and persisted against this same property integration on the first hosted payment.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
