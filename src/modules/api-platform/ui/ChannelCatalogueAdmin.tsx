import { useEffect, useState } from "react";
import { Loader2, Plus, Save } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { CHANNEL_TYPES } from "../channel-contracts";
import type { ChannelProviderDefinition } from "../channel-contracts";
import {
  listAllChannelDefinitionsForAdminFn,
  listChannelProvidersForAdminFn,
  upsertChannelDefinitionFn,
} from "../channel-catalog.functions";
import type { StoredChannelDefinition } from "../channel-catalog.server";

export function ChannelCatalogueAdmin() {
  const queryClient = useQueryClient();
  const listFn = useServerFn(listAllChannelDefinitionsForAdminFn);
  const providersFn = useServerFn(listChannelProvidersForAdminFn);
  const query = useQuery({
    queryKey: ["admin-channel-catalogue"],
    queryFn: () => listFn(),
    staleTime: 15_000,
  });
  const providersQuery = useQuery({
    queryKey: ["admin-channel-providers"],
    queryFn: () => providersFn(),
    staleTime: 60_000,
  });

  if (query.isLoading || providersQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading channel catalogue…</div>;
  }

  const channels = query.data ?? [];
  const providers = providersQuery.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Universal Channel Catalogue"
        description="Platform-controlled channel identities. Add or retire a channel without changing LexiBite POS, kitchen, inventory or intelligence code."
      />

      <SectionCard
        title="Supported provider adapters"
        description="Adapters are developer-controlled. A channel can only be published when its provider adapter is registered."
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <div key={provider.key} className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">{provider.name}</h3>
                <Badge variant="outline">{provider.key}</Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{provider.description}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Channel identities"
        description="These records are the customer-facing channels tenants can select in Universal Channel Centre."
      >
        <div className="space-y-3">
          {channels.map((channel) => (
            <ChannelDefinitionRow
              key={channel.key}
              channel={channel}
              providers={providers}
              onSaved={() => queryClient.invalidateQueries({ queryKey: ["admin-channel-catalogue"] })}
            />
          ))}
          <NewChannelDefinition
            providers={providers}
            onCreated={() => queryClient.invalidateQueries({ queryKey: ["admin-channel-catalogue"] })}
          />
        </div>
      </SectionCard>
    </div>
  );
}

function ChannelDefinitionRow({
  channel,
  providers,
  onSaved,
}: {
  channel: StoredChannelDefinition;
  providers: ChannelProviderDefinition[];
  onSaved: () => void;
}) {
  return (
    <ChannelEditor channel={channel} providers={providers} submitLabel="Save changes" icon={<Save className="mr-2 h-4 w-4" />} onSaved={onSaved} />
  );
}

function NewChannelDefinition({
  providers,
  onCreated,
}: {
  providers: ChannelProviderDefinition[];
  onCreated: () => void;
}) {
  return (
    <ChannelEditor
      providers={providers}
      submitLabel="Add channel"
      icon={<Plus className="mr-2 h-4 w-4" />}
      onSaved={onCreated}
    />
  );
}

function ChannelEditor({
  channel,
  providers,
  submitLabel,
  icon,
  onSaved,
}: {
  channel?: StoredChannelDefinition;
  providers: ChannelProviderDefinition[];
  submitLabel: string;
  icon: React.ReactNode;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(channel?.key ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [description, setDescription] = useState(channel?.description ?? "");
  const [providerKey, setProviderKey] = useState(channel?.providerKey ?? providers[0]?.key ?? "");
  const [category, setCategory] = useState(channel?.category ?? "ordering_platform");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(String(channel?.sortOrder ?? 100));

  useEffect(() => {
    if (!channel && !providerKey && providers[0]) setProviderKey(providers[0].key);
  }, [channel, providerKey, providers]);

  const mutation = useAdminMutation({
    mutationFn: (data: Parameters<typeof upsertChannelDefinitionFn>[0]["data"]) => upsertChannelDefinitionFn({ data }),
    successMessage: channel ? "Channel definition updated" : "Channel definition added",
    onSuccess: onSaved,
  });

  return (
    <div className="rounded-xl border bg-muted/10 p-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div><Label>Channel key</Label><Input value={key} onChange={(event) => setKey(event.target.value)} disabled={Boolean(channel)} placeholder="uber-eats" /></div>
        <div><Label>Display name</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Uber Eats" /></div>
        <div>
          <Label>Provider adapter</Label>
          <Select value={providerKey} onValueChange={setProviderKey}>
            <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
            <SelectContent>{providers.map((provider) => <SelectItem key={provider.key} value={provider.key}>{provider.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label>Category</Label>
          <Select value={category} onValueChange={(value) => setCategory(value as typeof category)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CHANNEL_TYPES.map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div><Label>Sort order</Label><Input type="number" min={0} value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} /></div>
        <div><Label>Description</Label><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Customer-facing channel description" /></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled for tenant connection
        </label>
        <Button
          disabled={mutation.isPending || !key.trim() || !name.trim() || !providerKey || !category}
          onClick={() => mutation.mutate({
            key,
            name,
            description,
            providerKey,
            category,
            enabled,
            sortOrder: Number(sortOrder) || 0,
          })}
        >
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
