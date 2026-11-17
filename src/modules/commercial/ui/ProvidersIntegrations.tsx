import { useMemo, useState } from "react";
import { CheckCircle2, CircleOff, CreditCard, Landmark, MessageSquare, Network, Pencil, Save, ShieldCheck, Smartphone } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useServerFn } from "@tanstack/react-start";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertCommercialProviderFn, updateCommercialProviderStatusFn } from "../commercial.functions";

const CATEGORY_LABELS: Record<string, string> = {
  payments: "Payments",
  mobile_money: "Mobile money",
  fiscal: "Fiscal",
  notifications: "Notifications",
  api: "API / Integration",
};

const CATEGORY_ICONS: Record<string, typeof CreditCard> = {
  payments: CreditCard,
  mobile_money: Smartphone,
  fiscal: Landmark,
  notifications: MessageSquare,
  api: Network,
};

type Provider = {
  id: string;
  code: string;
  name: string;
  category: string;
  integration_type: string;
  description: string | null;
  status: "enabled" | "disabled";
  sort_order: number;
};

function ProviderRow({ provider, onSaved }: { provider: Provider; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(provider.name);
  const [description, setDescription] = useState(provider.description ?? "");
  const update = useServerFn(upsertCommercialProviderFn);
  const toggle = useServerFn(updateCommercialProviderStatusFn);
  const mutation = useAdminMutation({
    mutationFn: (data: any) => update({ data }),
    successMessage: "Provider updated",
    onSuccess: () => { setEditing(false); onSaved(); },
  });
  const toggleMutation = useAdminMutation({
    mutationFn: (data: any) => toggle({ data }),
    successMessage: provider.status === "enabled" ? "Provider disabled" : "Provider enabled",
    onSuccess: onSaved,
  });
  const Icon = CATEGORY_ICONS[provider.category] ?? Network;

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 rounded-lg border bg-muted/40 p-2"><Icon className="h-4 w-4" /></div>
          <div className="min-w-0 space-y-1">
            {editing ? (
              <div className="space-y-2">
                <Label htmlFor={`provider-name-${provider.id}`}>Provider name</Label>
                <Input id={`provider-name-${provider.id}`} value={name} onChange={(e) => setName(e.target.value)} className="max-w-md" />
                <Label htmlFor={`provider-description-${provider.id}`}>Description</Label>
                <Input id={`provider-description-${provider.id}`} value={description} onChange={(e) => setDescription(e.target.value)} className="max-w-xl" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{provider.name}</h3>
                  <Badge variant="outline">{CATEGORY_LABELS[provider.category] ?? provider.category}</Badge>
                  <Badge variant={provider.status === "enabled" ? "default" : "secondary"}>
                    {provider.status === "enabled" ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{provider.description || "No platform description."}</p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{provider.code}</span>
                  <span>·</span>
                  <span>{provider.integration_type}</span>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({
                id: provider.id,
                code: provider.code,
                name,
                category: provider.category,
                integrationType: provider.integration_type,
                description,
                status: provider.status,
                sortOrder: provider.sort_order,
              })}><Save className="mr-2 h-4 w-4" />Save</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
              <Button
                size="sm"
                variant={provider.status === "enabled" ? "outline" : "default"}
                disabled={toggleMutation.isPending}
                onClick={() => toggleMutation.mutate({ id: provider.id, status: provider.status === "enabled" ? "disabled" : "enabled" })}
              >
                {provider.status === "enabled" ? <><CircleOff className="mr-2 h-4 w-4" />Disable</> : <><CheckCircle2 className="mr-2 h-4 w-4" />Enable</>}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProvidersIntegrationsPanel({
  providers,
  onSaved,
}: {
  providers: Provider[];
  onSaved: () => void;
}) {
  const grouped = useMemo(() => {
    return providers.reduce<Record<string, Provider[]>>((acc, provider) => {
      (acc[provider.category] ??= []).push(provider);
      return acc;
    }, {});
  }, [providers]);
  const [newProvider, setNewProvider] = useState({
    code: "", name: "", category: "payments", integrationType: "payment", description: "", status: "disabled", sortOrder: 100,
  });
  const create = useServerFn(upsertCommercialProviderFn);
  const mutation = useAdminMutation({
    mutationFn: (data: any) => create({ data }),
    successMessage: "Provider registered",
    onSuccess: () => {
      setNewProvider({ code: "", name: "", category: "payments", integrationType: "payment", description: "", status: "disabled", sortOrder: 100 });
      onSaved();
    },
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Providers & Integrations"
        description="Platform-level provider governance. Control which supported providers are available to tenants without exposing provider secrets."
      >
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4" />Platform control boundary</div>
          <p className="mt-1">Commercial administrators control the provider catalogue here. Tenant owners and general managers configure their property's approved connection in the operational Payments, Fiscal and Integration surfaces. Secrets remain server-side.</p>
        </div>
      </SectionCard>

      {Object.entries(grouped).map(([category, rows]) => (
        <SectionCard key={category} title={CATEGORY_LABELS[category] ?? category} description={`${rows.length} registered provider${rows.length === 1 ? "" : "s"}`}>
          <div className="space-y-3">
            {rows.map((provider) => <ProviderRow key={provider.id} provider={provider} onSaved={onSaved} />)}
          </div>
        </SectionCard>
      ))}

      <SectionCard title="Register provider" description="Add a provider definition to the platform catalogue. This does not create or expose tenant credentials.">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div><Label>Code</Label><Input value={newProvider.code} onChange={(e) => setNewProvider((p) => ({ ...p, code: e.target.value }))} placeholder="provider_code" /></div>
          <div><Label>Name</Label><Input value={newProvider.name} onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))} placeholder="Provider name" /></div>
          <div>
            <Label>Category</Label>
            <Select value={newProvider.category} onValueChange={(value) => setNewProvider((p) => ({ ...p, category: value }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="payments">Payments</SelectItem>
                <SelectItem value="mobile_money">Mobile money</SelectItem>
                <SelectItem value="fiscal">Fiscal</SelectItem>
                <SelectItem value="notifications">Notifications</SelectItem>
                <SelectItem value="api">API / Integration</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Integration type</Label><Input value={newProvider.integrationType} onChange={(e) => setNewProvider((p) => ({ ...p, integrationType: e.target.value }))} /></div>
        </div>
        <div className="mt-4"><Label>Description</Label><Input value={newProvider.description} onChange={(e) => setNewProvider((p) => ({ ...p, description: e.target.value }))} placeholder="What this provider is used for" /></div>
        <div className="mt-4 flex justify-end"><Button disabled={mutation.isPending || !newProvider.code || !newProvider.name} onClick={() => mutation.mutate(newProvider)}>Register provider</Button></div>
      </SectionCard>
    </div>
  );
}
