/* Platform-level AI/LLM provider control. Secrets never leave the server. */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";

type Sb = any;



export async function listAiProviders(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const { data: providers, error } = await sb
    .from("commercial_ai_providers")
    .select("id,code,name,status,priority,default_model,configured_env_key,endpoint_url,protocol,description,created_at,updated_at,commercial_ai_models(id,code,name,status,priority,capabilities)")
    .order("priority", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  const { data: usage, error: usageError } = await sb
    .from("commercial_ai_usage_log")
    .select("provider,model,input_usage,output_usage,estimated_cost,currency,request_count,occurred_at")
    .gte("occurred_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  if (usageError) throw new Error(usageError.message);

  const usageByProvider = new Map<string, { requests: number; input: number; output: number; cost: number; currency: string }>();
  for (const row of usage ?? []) {
    const current = usageByProvider.get(row.provider) ?? { requests: 0, input: 0, output: 0, cost: 0, currency: row.currency ?? "USD" };
    current.requests += Number(row.request_count ?? 0);
    current.input += Number(row.input_usage ?? 0);
    current.output += Number(row.output_usage ?? 0);
    current.cost += Number(row.estimated_cost ?? 0);
    usageByProvider.set(row.provider, current);
  }

  return (providers ?? []).map((provider: any) => {
    const usage = usageByProvider.get(provider.code) ?? { requests: 0, input: 0, output: 0, cost: 0, currency: "USD" };
    const configured = Boolean(process.env[provider.configured_env_key]);
    return {
      ...provider,
      configured,
      configurationStatus: configured ? "configured" : "not_configured",
      healthStatus: configured && provider.status === "enabled" ? "ready" : provider.status === "disabled" ? "disabled" : "not_configured",
      usage30d: usage,
      creditStatus: "not_reported",
      models: provider.commercial_ai_models ?? [],
    };
  });
}

export async function updateAiProviderStatus(sb: Sb, userId: string, id: string, status: "enabled" | "disabled") {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_ai_providers")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,code,name,status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_ai_provider.status_changed",
    entityType: "commercial_ai_provider",
    entityId: id,
    after: { code: data.code, status: data.status },
  });
  return data;
}

export async function updateAiModelStatus(sb: Sb, userId: string, id: string, status: "enabled" | "disabled") {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_ai_models")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,provider_id,code,status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_ai_model.status_changed",
    entityType: "commercial_ai_model",
    entityId: id,
    after: { code: data.code, status: data.status },
  });
  return data;
}

export async function updateAiProviderPriority(sb: Sb, userId: string, id: string, priority: number) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_ai_providers")
    .update({ priority, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,code,priority")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_ai_provider.priority_changed",
    entityType: "commercial_ai_provider",
    entityId: id,
    after: { code: data.code, priority: data.priority },
  });
  return data;
}

export async function createAiProvider(
  sb: Sb,
  userId: string,
  input: {
    code: string;
    name: string;
    configuredEnvKey: string;
    endpointUrl: string;
    protocol: "chat-completions" | "responses";
    defaultModel: string;
    description?: string;
  },
) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb.from("commercial_ai_providers").insert({
    code: input.code.trim().toLowerCase(),
    name: input.name.trim(),
    configured_env_key: input.configuredEnvKey.trim(),
    endpoint_url: input.endpointUrl.trim(),
    protocol: input.protocol,
    default_model: input.defaultModel.trim(),
    description: input.description?.trim() ?? "",
    status: "disabled",
    priority: 100,
  }).select("id,code,name,status,priority,default_model,configured_env_key,endpoint_url,protocol,description").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_ai_provider.created",
    entityType: "commercial_ai_provider",
    entityId: data.id,
    after: data,
  });
  return data;
}

export async function createAiModel(
  sb: Sb,
  userId: string,
  input: { providerId: string; code: string; name: string; capabilities?: string[]; priority?: number },
) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb.from("commercial_ai_models").insert({
    provider_id: input.providerId,
    code: input.code.trim(),
    name: input.name.trim(),
    status: "enabled",
    priority: input.priority ?? 100,
    capabilities: input.capabilities ?? [],
  }).select("id,provider_id,code,name,status,priority,capabilities").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_ai_model.created",
    entityType: "commercial_ai_model",
    entityId: data.id,
    after: data,
  });
  return data;
}
