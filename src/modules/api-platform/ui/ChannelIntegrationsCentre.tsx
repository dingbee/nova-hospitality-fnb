import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, Loader2, Plus, RefreshCw } from "lucide-react";
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
import { listChannelDefinitionsFn } from "../channel-catalog.functions";
import type { StoredChannelDefinition } from "../channel-catalog.server";
import type { ChannelConnection, ChannelConnectionConfig, ChannelProviderDefinition } from "../channel-contracts";
import {
  createChannelConnectionFn,
  listChannelConnectionsFn,
  testChannelConnectionFn,
  updateChannelConnectionFn,
} from "../channel.functions";

type Property = { id: string; name: string };

export function ChannelIntegrationsCentre() {
  const ws = useRestaurantWorkspace();
  const tenant = ws.data?.tenant;
  const listFn = useServerFn(listChannelConnectionsFn);
  const listChannelsFn = useServerFn(listChannelDefinitionsFn);
  const queryClient = useQueryClient();
  const channelsQuery = useQuery({
    queryKey: ["channel-definitions"],
    queryFn: () => listChannelsFn({ data: { enabledOnly: true } }),
    staleTime: 60_000,
  });

  const query = useQuery({
    queryKey: ["channel-integrations", tenant?.id],
    enabled: Boolean(tenant?.id),
    queryFn: () => listFn({ data: { tenantId: tenant!.id } }),
    staleTime: 15_000,
  });

  if (ws.isLoading || query.isLoading || channelsQuery.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading integrations…</div>;
  if (!tenant) return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;

  const connections = query.data ?? [];
  const channels = channelsQuery.data ?? [];
  const canManage = Boolean(ws.data?.platformAdmin || ws.data?.roles?.some((role: string) => role === "owner" || role === "general_manager"));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Channel Integrations"
        description="Connect external ordering and delivery channels to this restaurant. Your operational workflows remain in LexiBite."
      />

      <ProviderCatalog channels={channels} />

      <ConnectionList
        tenantId={tenant.id}
        properties={ws.data?.properties ?? []}
        connections={connections}
        channels={channels}
        canManage={canManage}
        onRefresh={() => queryClient.invalidateQueries({ queryKey: ["channel-integrations", tenant.id] })}
      />

      <NewConnection
        tenantId={tenant.id}
        properties={ws.data?.properties ?? []}
        channels={channels}
        canManage={canManage}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["channel-integrations", tenant.id] })}
      />
    </div>
  );
}

function ProviderCatalog({ channels }: { channels: StoredChannelDefinition[] }) {
  return (
    <SectionCard
      title="Universal channels"
      description="Channels are the operational identities tenants connect. Each channel resolves to a provider adapter without exposing provider transport as the product model."
    >
      {channels.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {channels.map((channel) => {
            const provider = CHANNEL_PROVIDERS.find((item) => item.key === channel.providerKey);
            return (
              <div key={channel.key} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{channel.name}</h3>
                    <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{channel.category.replaceAll("_", " ")}</p>
                  </div>
                  <Badge variant="outline">Available</Badge>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{channel.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{provider?.name ?? channel.providerKey}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No external channels are currently available.</p>
      )}
    </SectionCard>
  );
}

function ConnectionList({
  tenantId,
  properties,
  connections,
  channels,
  canManage,
  onRefresh,
}: {
  tenantId: string;
  properties: Property[];
  connections: ChannelConnection[];
  channels: StoredChannelDefinition[];
  canManage: boolean;
  onRefresh: () => void;
}) {
  if (!connections.length) {
    return (
      <SectionCard title="Connected channels" description="No external channel is connected yet.">
        <p className="text-sm text-muted-foreground">Choose an available channel below to connect it to this restaurant.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Connected channels" description={`${connections.length} connection${connections.length === 1 ? "" : "s"} configured`}>
      <div className="space-y-3">
        {connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            tenantId={tenantId}
            properties={properties}
            connection={connection}
            channels={channels}
            canManage={canManage}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function ConfigFields({
  provider,
  config,
  onChange,
  disabled = false,
}: {
  provider: ChannelProviderDefinition;
  config: ChannelConnectionConfig;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {provider.setup.fields.map((field) => (
        <div key={field.key}>
          <Label>{field.label}</Label>
          <Input
            type={field.type}
            value={String(config[field.key] ?? "")}
            onChange={(event) => onChange(field.key, event.target.value)}
            placeholder={field.placeholder}
            disabled={disabled}
          />
        </div>
      ))}
    </>
  );
}

function ConnectionRow({
  tenantId,
  properties,
  connection,
  channels,
  canManage,
  onRefresh,
}: {
  tenantId: string;
  properties: Property[];
  connection: ChannelConnection;
  channels: StoredChannelDefinition[];
  canManage: boolean;
  onRefresh: () => void;
}) {
  const channel = channels.find((item) => item.key === connection.channelKey) ?? null;
  const provider = CHANNEL_PROVIDERS.find((item) => item.key === connection.providerKey);
  const test = useServerFn(testChannelConnectionFn);
  const update = useServerFn(updateChannelConnectionFn);
  const [credential, setCredential] = useState("");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(connection.label);
  const [propertyId, setPropertyId] = useState(connection.propertyId ?? "tenant");
  const [config, setConfig] = useState<ChannelConnectionConfig>(connection.config);

  const testMutation = useAdminMutation({
    mutationFn: (data: Parameters<typeof testChannelConnectionFn>[0]["data"]) => test({ data }),
    successMessage: "Connection test completed",
    onSuccess: onRefresh,
  });
  const updateMutation = useAdminMutation({
    mutationFn: (data: Parameters<typeof updateChannelConnectionFn>[0]["data"]) => update({ data }),
    successMessage: "Channel connection updated",
    onSuccess: () => { setEditing(false); setCredential(""); onRefresh(); },
  });

  if (!provider) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{connection.label}</h3>
          <Badge variant="destructive">Unknown provider</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Provider {connection.providerKey} is not currently registered. The connection is preserved but cannot be operated until its adapter is restored.</p>
      </div>
    );
  }

  const propertyName = propertyId === "tenant" ? "All properties" : properties.find((property) => property.id === propertyId)?.name ?? "Property";

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{connection.label}</h3>
            {channel ? <Badge variant="outline">{channel.name}</Badge> : null}
            <Badge variant="outline">Adapter: {provider.name}</Badge>
            <Badge variant={connection.status === "active" ? "default" : connection.status === "error" ? "destructive" : "secondary"}>{connection.status}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">{propertyName}</div>
          <div className="flex flex-wrap gap-2">
            {provider.setup.fields.map((field) => (
              <Badge key={field.key} variant="outline">
                {field.label}: {String(connection.config[field.key] ?? "—")}
              </Badge>
            ))}
          </div>
          {connection.lastError ? <p className="text-sm text-destructive">{connection.lastError}</p> : null}
          {connection.lastSyncedAt ? <p className="text-xs text-muted-foreground">Last verified: {new Date(connection.lastSyncedAt).toLocaleString()}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {canManage ? (
            <Button size="sm" variant="outline" disabled={testMutation.isPending || connection.status === "disabled"} onClick={() => testMutation.mutate({ tenantId, integrationId: connection.id })}>
              {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Test connection
            </Button>
          ) : null}
          {canManage ? <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</Button> : null}
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateMutation.mutate({ tenantId, integrationId: connection.id, status: connection.status === "disabled" ? "active" : "disabled" })}
              disabled={updateMutation.isPending}
            >
              {connection.status === "disabled" ? "Enable" : "Disable"}
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-2">
          <div><Label>Connection name</Label><Input value={label} onChange={(event) => setLabel(event.target.value)} /></div>
          <div><Label>Property scope</Label><PropertySelect value={propertyId} properties={properties} onChange={setPropertyId} /></div>
          <ConfigFields provider={provider} config={config} onChange={(key, value) => setConfig((current) => ({ ...current, [key]: value }))} />
          <div className="md:col-span-2">
            <Label>Replace {provider.setup.credential.label}</Label>
            <Input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Leave blank to keep the stored credential" autoComplete="new-password" />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button disabled={updateMutation.isPending} onClick={() => updateMutation.mutate({
              tenantId,
              integrationId: connection.id,
              propertyId: propertyId === "tenant" ? null : propertyId,
              label,
              config,
              credential: credential || undefined,
            })}>
              <CheckCircle2 className="mr-2 h-4 w-4" />Save changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PropertySelect({ value, properties, onChange }: { value: string; properties: Property[]; onChange: (value: string) => void }) {
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

function NewConnection({
  tenantId,
  properties,
  channels,
  canManage,
  onCreated,
}: {
  tenantId: string;
  properties: Property[];
  channels: StoredChannelDefinition[];
  canManage: boolean;
  onCreated: () => void;
}) {
  const create = useServerFn(createChannelConnectionFn);
  const [channelKey, setChannelKey] = useState(channels[0]?.key ?? "");
  const channel = channels.find((item) => item.key === channelKey) ?? null;
  const provider = channel ? CHANNEL_PROVIDERS.find((item) => item.key === channel.providerKey) ?? null : null;
  const [label, setLabel] = useState("");
  const [propertyId, setPropertyId] = useState("tenant");
  const [config, setConfig] = useState<ChannelConnectionConfig>({});
  const [credential, setCredential] = useState("");

  useEffect(() => {
    setConfig({});
    setCredential("");
  }, [channelKey]);

  const mutation = useAdminMutation({
    mutationFn: (data: Parameters<typeof createChannelConnectionFn>[0]["data"]) => create({ data }),
    successMessage: "Channel connection created",
    onSuccess: () => {
      setLabel("");
      setConfig({});
      setCredential("");
      setPropertyId("tenant");
      onCreated();
    },
  });

  if (!canManage) {
    return (
      <SectionCard title="Connect a channel" description="Only tenant owners and general managers can change channel connections.">
        <p className="text-sm text-muted-foreground">You can view the tenant's connections, but credentials and operational controls are restricted to authorized tenant administrators.</p>
      </SectionCard>
    );
  }

  const requiredFieldsComplete = provider?.setup.fields.filter((field) => field.required).every((field) => String(config[field.key] ?? "").trim().length > 0) ?? false;

  return (
    <SectionCard
      title="Connect a channel"
      description="Select a channel, enter its connection details, and verify the connection."
    >
      {!provider ? (
        <p className="text-sm text-muted-foreground">No external channels are currently enabled by platform administration.</p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Channel</Label>
              <Select value={channelKey} onValueChange={setChannelKey}>
                <SelectTrigger><SelectValue placeholder="Select channel" /></SelectTrigger>
                <SelectContent>
                  {channels.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {channel && provider ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">Adapter: {provider.name}</Badge>
                  <Badge variant="outline">{channel.category.replaceAll("_", " ")}</Badge>
                  
                  {provider.setup.docsUrl ? (
                    <a className="inline-flex items-center font-medium underline underline-offset-2" href={provider.setup.docsUrl} target="_blank" rel="noreferrer">
                      Provider documentation <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div><Label>Connection name</Label><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Main external ordering channel" /></div>
            <div><Label>Property scope</Label><PropertySelect value={propertyId} properties={properties} onChange={setPropertyId} /></div>
            <ConfigFields provider={provider} config={config} onChange={(key, value) => setConfig((current) => ({ ...current, [key]: value }))} />
            <div>
              <Label>{provider.setup.credential.label}</Label>
              <Input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Paste once; never shown again" autoComplete="new-password" />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">Connection credentials are stored securely and are not shown again after saving.</p>
            <Button
              disabled={mutation.isPending || !label.trim() || !requiredFieldsComplete || (provider.setup.credential.required && credential.length < 8)}
              onClick={() => mutation.mutate({
                tenantId,
                propertyId: propertyId === "tenant" ? null : propertyId,
                channelKey: channel.key,
                label,
                config,
                credential,
              })}
            >
              {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Connect channel
            </Button>
          </div>
        </>
      )}
    </SectionCard>
  );
}
