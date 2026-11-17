/* Platform-level provider registry. No tenant secrets are stored here. */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type { UpsertCommercialProviderInput, UpdateCommercialProviderStatusInput } from "./provider.contracts";

type Sb = any;

export async function listProviders(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_providers")
    .select("id, code, name, category, integration_type, description, status, sort_order, created_at, updated_at")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertProvider(sb: Sb, userId: string, input: UpsertCommercialProviderInput) {
  await assertCommercialAdmin(sb, userId);
  const payload = {
    code: input.code,
    name: input.name,
    category: input.category,
    integration_type: input.integrationType,
    description: input.description,
    status: input.status,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const query = input.id
    ? sb.from("commercial_providers").update(payload).eq("id", input.id).select().single()
    : sb.from("commercial_providers").insert(payload).select().single();
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "commercial_provider.updated" : "commercial_provider.created",
    entityType: "commercial_provider",
    entityId: data.id,
    after: {
      code: data.code,
      name: data.name,
      category: data.category,
      integrationType: data.integration_type,
      status: data.status,
    },
  });
  return data;
}

export async function updateProviderStatus(
  sb: Sb,
  userId: string,
  input: UpdateCommercialProviderStatusInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_providers")
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq("id", input.id)
    .select()
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_provider.status_changed",
    entityType: "commercial_provider",
    entityId: input.id,
    after: { status: input.status, code: data.code },
  });
  return data;
}
