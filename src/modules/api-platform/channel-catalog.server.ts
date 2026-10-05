import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCommercialAdmin } from "@/modules/commercial/access.server";
import { CHANNEL_PROVIDERS, getChannelProviderDefinition } from "./channel-catalog";
import { CHANNEL_TYPES, type ChannelDefinition, type ChannelType } from "./channel-contracts";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Sb = SupabaseClient<any, any, any>;

export type StoredChannelDefinition = ChannelDefinition & {
  enabled: boolean;
  sortOrder: number;
};

export async function listChannelDefinitions(sb: Sb, enabledOnly = true): Promise<StoredChannelDefinition[]> {
  let query = sb
    .from("api_channel_definitions")
    .select("key, name, description, provider_key, category, enabled, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (enabledOnly) query = query.eq("enabled", true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    providerKey: row.provider_key,
    category: row.category,
    enabled: row.enabled,
    sortOrder: row.sort_order,
  }));
}

export async function getChannelDefinition(sb: Sb, key: string): Promise<StoredChannelDefinition | null> {
  const { data, error } = await sb
    .from("api_channel_definitions")
    .select("key, name, description, provider_key, category, enabled, sort_order")
    .eq("key", key)
    .eq("enabled", true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    key: data.key,
    name: data.name,
    description: data.description,
    providerKey: data.provider_key,
    category: data.category,
    enabled: data.enabled,
    sortOrder: data.sort_order,
  };
}

export async function listAllChannelDefinitionsForAdmin(sb: Sb, userId: string): Promise<StoredChannelDefinition[]> {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await supabaseAdmin
    .from("api_channel_definitions")
    .select("key, name, description, provider_key, category, enabled, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    providerKey: row.provider_key,
    category: row.category,
    enabled: row.enabled,
    sortOrder: row.sort_order,
  }));
}

export async function upsertChannelDefinition(
  sb: Sb,
  userId: string,
  input: {
    key: string;
    name: string;
    description: string;
    providerKey: string;
    category: ChannelType;
    enabled: boolean;
    sortOrder: number;
  },
) {
  await assertCommercialAdmin(sb, userId);
  if (!getChannelProviderDefinition(input.providerKey)) {
    throw new Error(`Unsupported channel provider: ${input.providerKey}`);
  }

  const { data, error } = await supabaseAdmin
    .from("api_channel_definitions")
    .upsert({
      key: input.key,
      name: input.name,
      description: input.description,
      provider_key: input.providerKey,
      category: input.category,
      enabled: input.enabled,
      sort_order: input.sortOrder,
      created_by: userId,
    }, { onConflict: "key" })
    .select("key, name, description, provider_key, category, enabled, sort_order")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function listChannelProvidersForAdmin(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);
  return CHANNEL_PROVIDERS;
}

export function isChannelType(value: string): value is ChannelType {
  return CHANNEL_TYPES.includes(value as ChannelType);
}
