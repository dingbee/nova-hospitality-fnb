import { useMemo } from "react";
import { CheckCircle2, CircleOff, Cpu, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { updateCommercialAiProviderPriorityFn, updateCommercialAiProviderStatusFn, updateCommercialAiModelStatusFn } from "../commercial.functions";

type Provider = {
  id: string; code: string; name: string; status: "enabled" | "disabled"; priority: number;
  default_model: string; description: string; configured: boolean;
  configurationStatus: string; healthStatus: string;
  creditStatus: string;
  usage30d: { requests: number; input: number; output: number; cost: number; currency: string };
  models: Array<{ id: string; code: string; name: string; status: "enabled" | "disabled"; priority: number; capabilities: string[] }>;
};

const statusLabel = (p: Provider) =>
  p.status === "disabled" ? "Disabled" : p.configured ? "Ready" : "Not configured";

export function AIProvidersPanel({ providers, onSaved }: { providers: Provider[]; onSaved: () => void }) {
  const updateStatus = useServerFn(updateCommercialAiProviderStatusFn);
  const updatePriority = useServerFn(updateCommercialAiProviderPriorityFn);
  const updateModelStatus = useServerFn(updateCommercialAiModelStatusFn);
  const statusMutation = useAdminMutation({ mutationFn: (data: any) => updateStatus({ data }), successMessage: "AI provider updated", onSuccess: onSaved });
  const priorityMutation = useAdminMutation({ mutationFn: (data: any) => updatePriority({ data }), successMessage: "AI routing priority updated", onSuccess: onSaved });
  const modelMutation = useAdminMutation({ mutationFn: (data: any) => updateModelStatus({ data }), successMessage: "AI model updated", onSuccess: onSaved });

  const ordered = useMemo(() => [...providers].sort((a,b) => a.priority - b.priority), [providers]);

  return (
    <div className="space-y-6">
      <SectionCard title="AI / LLM Providers" description="Platform-level AI infrastructure. This is not tenant payment, fiscal or messaging configuration.">
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4" />Nolmark platform control</div>
          <p className="mt-1">Enable or disable an LLM provider, change routing priority, and inspect server-side configuration and recorded usage. API keys are never shown.</p>
        </div>
      </SectionCard>

      <SectionCard title="Provider routing" description="Lower priority number means higher routing priority. Usage is the last 30 days from LexiBite's AI usage ledger.">
        <div className="space-y-3">
          {ordered.map((p) => (
            <div key={p.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="flex min-w-0 gap-3">
                  <div className="mt-0.5 rounded-lg border bg-muted/40 p-2"><Cpu className="h-4 w-4" /></div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{p.name}</h3>
                      <Badge variant={p.status === "enabled" ? "default" : "secondary"}>{statusLabel(p)}</Badge>
                      <Badge variant="outline">Priority #{ordered.findIndex(x => x.id === p.id) + 1}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
                    <div className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                      <div><div className="text-xs text-muted-foreground">Configuration</div><div className="font-medium">{p.configured ? "Configured" : "Missing server key"}</div></div>
                      <div><div className="text-xs text-muted-foreground">Health</div><div className="font-medium">{p.healthStatus === "ready" ? "Ready" : p.healthStatus === "disabled" ? "Disabled" : "Not configured"}</div></div>
                      <div><div className="text-xs text-muted-foreground">Usage · 30d</div><div className="font-medium">{p.usage30d.requests.toLocaleString()} requests</div><div className="text-xs text-muted-foreground">{(p.usage30d.input + p.usage30d.output).toLocaleString()} tokens</div></div>
                      <div><div className="text-xs text-muted-foreground">Credits</div><div className="font-medium">Not reported</div><div className="text-xs text-muted-foreground">Provider account balance not exposed by LexiBite.</div></div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {p.models.map((m) => (
                        <Badge key={m.id} variant={m.status === "enabled" ? "outline" : "secondary"}>
                          {m.name} · {m.status === "enabled" ? "Active" : "Disabled"}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => priorityMutation.mutate({ id: p.id, priority: Math.max(0, p.priority - 10) })}>Promote</Button>
                  <Button size="sm" variant="outline" onClick={() => priorityMutation.mutate({ id: p.id, priority: p.priority + 10 })}>Demote</Button>
                  <Button size="sm" variant={p.status === "enabled" ? "outline" : "default"} onClick={() => statusMutation.mutate({ id: p.id, status: p.status === "enabled" ? "disabled" : "enabled" })} disabled={statusMutation.isPending}>
                    {p.status === "enabled" ? <><CircleOff className="mr-2 h-4 w-4" />Disable</> : <><CheckCircle2 className="mr-2 h-4 w-4" />Enable</>}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
