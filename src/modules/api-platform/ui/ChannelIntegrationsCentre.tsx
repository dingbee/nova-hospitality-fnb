import { useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, Link2, Loader2, Plus, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { CHANNEL_PROVIDERS } from "../channel-catalog";
import {
  createChannelConnectionFn,
  listChannelConnectionsFn,
  testChannelConnectionFn,
  updateChannelConnectionFn,
} from "../channel.functions";

export function ChannelIntegrationsCentre() {
  const ws = useRestaurantWorkspace();
  const tenant = ws.data?.tenant;
  const listFn = useServerFn(listChannelConnectionsFn);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["channel-integrations", tenant?.id],
    enabled: Boolean(tenant?.id),
    queryFn: () => listFn({ data: { tenantId: tenant!.id } }),
    staleTime: 15_000,
  });

  if (ws.isLoading || query.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading integrations…</div>;
  if (!tenant) return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;

  const connections = query.data ?? [];
  const canManage = Boolean(ws.data?.platformAdmin || ws.data?.roles?.some((role: string) => role === "owner" || role === "general_manager"));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Channel Integrations"
        description="Connect external ordering and delivery channels to LexiBite without changing the core POS."
      />

      <SectionCard
        title="Universal channel layer"
        description="Every external channel is normalized into the same LexiBite order, menu and status contracts. Providers stay outside the restaurant core."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <BoundaryCard icon={<Link2 className="h-4 w-4" />} title="One operational core" text="Piki, Uber Eats, Glovo and future channels can enter through the same integration boundary." />
          <BoundaryCard icon={<ShieldCheck className="h-4 w-4" />} title="Tenant controlled" text="Owners and general managers configure approved connections here. Provider secrets never appear after save." />
          <BoundaryCard icon={<Unplug className="h-4 w-4" />} title="Replaceable adapters" text="A channel adapter can change without changing POS, kitchen, inventory or intelligence logic." />
        </div>
      </SectionCard>

      <ConnectionList
        tenantId={tenant.id}
        properties={ws.data?.properties ?? []}
        connections={connections}
        canManage={canManage}
        onRefresh={() => queryClient.invalidateQueries({ queryKey: ["channel-integrations", tenant.id] })}
      />

      <NewConnection
        tenantId={tenant.id}
        properties={ws.data?.properties ?? []}
        canManage={canManage}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["channel-integrations", tenant.id] })}
      />
    </div>
  );
}

function BoundaryCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center gap-2 font-medium"><span className="rounded-lg border bg-background p-2">{icon}</span>{title}</div>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function ConnectionList({ tenantId, properties, connections, canManage, onRefresh }: {
  tenantId: string;
  properties: Array<{ id: string; name: string }>;
  connections: any[];
  canManage: boolean;
  onRefresh: () => void;
}) {
  if (!connections.length) {
    return (
      <SectionCard title="Connected channels" description="No external channel is connected to this tenant yet.">
        <p className="text-sm text-muted-foreground">Start with Ordering.co below. Piki is a project running on Ordering.co, so no Piki-specific connector is created.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Connected channels" description={\`\${connections.length} connection\${connections.length === 1 ? "" : "s"} configured\`}>
      <div className="space-y-3">
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} tenantId={tenantId} properties={properties} connection={connection} canManage={canManage} onRefresh={onRefresh} />
        ))}
      </div>
    </SectionCard>
  );
}

function ConnectionRow({ tenantId, properties, connection, canManage, onRefresh }: any) {
  const provider = CHANNEL_PROVIDERS.find((p) => p.key === connection.providerKey);
  const test = useServerFn(testChannelConnectionFn);
  const update = useServerFn(updateChannelConnectionFn);
  const [newKey, setNewKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(connection.label);
  const [businessId, setBusinessId] = useState(connection.config.businessId ?? "");
  const [propertyId, setPropertyId] = useState(connection.propertyId ?? "tenant");

  const testMutation = useAdminMutation({
    mutationFn: (data: any) => test({ data }),
    successMessage: "Connection test completed",
    onSuccess: onRefresh,
  });
  const updateMutation = useAdminMutation({
    mutationFn: (data: any) => update({ data }),
    successMessage: "Channel connection updated",
    onSuccess: () => { setEditing(false); setNewKey(""); onRefresh(); },
  });

  const propertyName = propertyId === "tenant" ? "All properties" : properties.find((p) => p.id === propertyId)?.name ?? "Property";
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{connection.label}</h3>
            <Badge variant="outline">{provider?.name ?? connection.providerKey}</Badge>
            <Badge variant={connection.status === "active" ? "default" : connection.status === "error" ? "destructive" : "secondary"}>{connection.status}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {propertyName} · Project <span className="font-mono">{connection.config.projectId}</span>
            {connection.config.businessId ? <> · Business <span className="font-mono">{connection.config.businessId}</span></> : null}
          </div>
          {connection.lastError ? <p className="text-sm text-destructive">{connection.lastError}</p> : null}
          {connection.lastSyncedAt ? <p className="text-xs text-muted-foreground">Last verified: {new Date(connection.lastSyncedAt).toLocaleString()}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {canManage ? <Button size="sm" variant="outline" disabled={testMutation.isPending} onClick={() => testMutation.mutate({ tenantId, integrationId: connection.id })}>
            {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Test connection
          </Button> : null}
          {canManage ? <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</Button> : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-2">
          <div><Label>Connection name</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <div><Label>Property scope</Label><PropertySelect value={propertyId} properties={properties} onChange={setPropertyId} /></div>
          <div><Label>Project ID</Label><Input value={connection.config.projectId} disabled /></div>
          <div><Label>Business ID</Label><Input value={businessId} onChange={(e) => setBusinessId(e.target.value)} placeholder="Optional" /></div>
          <div className="md:col-span-2">
            <Label>Replace API key</Label>
            <Input type="password" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="Leave blank to keep the stored credential" autoComplete="new-password" />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button disabled={updateMutation.isPending} onClick={() => updateMutation.mutate({
              tenantId,
              integrationId: connection.id,
              propertyId: propertyId === "tenant" ? null : propertyId,
              label,
              config: { businessId: businessId || undefined },
              apiKey: newKey || undefined,
            })}>
              <CheckCircle2 className="mr-2 h-4 w-4" />Save changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PropertySelect({ value, properties, onChange }: { value: string; properties: Array<{ id: string; name: string }>; onChange: (value: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="tenant">All properties</SelectItem>
        {properties.map((property) => <SelectItem key={property.id} value={property.id}>{property.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function NewConnection({ tenantId, properties, canManage, onCreated }: { tenantId: string; properties: Array<{ id: string; name: string }>; canManage: boolean; onCreated: () => void }) {
  const create = useServerFn(createChannelConnectionFn);
  const provider = CHANNEL_PROVIDERS[0];
  const [label, setLabel] = useState("");
  const [propertyId, setPropertyId] = useState("tenant");
  const [projectId, setProjectId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const mutation = useAdminMutation({
    mutationFn: (data: any) => create({ data }),
    successMessage: "Channel connection created",
    onSuccess: () => { setLabel(""); setProjectId(""); setBusinessId(""); setApiKey(""); setPropertyId("tenant"); onCreated(); },
  });

  if (!canManage) {
    return (
      <SectionCard title="Connect a channel" description="Only tenant owners and general managers can change channel connections.">
        <p className="text-sm text-muted-foreground">You can view the tenant's connections, but connection credentials and operational controls are restricted to authorized tenant administrators.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Connect a channel" description="Tenant owners and general managers can connect an approved provider. Credentials are stored server-side and are never displayed after save.">
      <div className="grid gap-4 md:grid-cols-2">
        <div><Label>Provider</Label><Input value={provider.name} disabled /></div>
        <div><Label>Connection name</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Piki / Ordering.co" /></div>
        <div><Label>Property scope</Label><PropertySelect value={propertyId} properties={properties} onChange={setPropertyId} /></div>
        <div><Label>{provider.setup.projectLabel}</Label><Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Ordering project ID" /></div>
        <div><Label>{provider.setup.businessLabel ?? "Business ID"}</Label><Input value={businessId} onChange={(e) => setBusinessId(e.target.value)} placeholder="Optional" /></div>
        <div><Label>{provider.setup.credentialLabel}</Label><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste once; never shown again" autoComplete="new-password" /></div>
      </div>

      <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-sm">
        <div className="font-medium">{provider.name}</div>
        <p className="mt-1 text-muted-foreground">{provider.description}</p>
        <div className="mt-2 flex flex-wrap gap-2">{provider.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</div>
        {provider.setup.docsUrl ? <a className="mt-3 inline-flex items-center text-xs font-medium underline" href={provider.setup.docsUrl} target="_blank" rel="noreferrer">Provider setup documentation <ExternalLink className="ml-1 h-3 w-3" /></a> : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">Advanced integrations are entitlement-controlled. Normal tenant configuration is performed here; no Supabase dashboard action is required.</p>
        <Button disabled={mutation.isPending || !label.trim() || !projectId.trim() || apiKey.length < 8} onClick={() => mutation.mutate({
          tenantId,
          propertyId: propertyId === "tenant" ? null : propertyId,
          providerKey: provider.key,
          label,
          config: { projectId, languageCode: "en", businessId: businessId || undefined, baseUrl: "https://api.ordering.co" },
          apiKey,
        })}>
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Connect channel
        </Button>
      </div>
    </SectionCard>
  );
}
