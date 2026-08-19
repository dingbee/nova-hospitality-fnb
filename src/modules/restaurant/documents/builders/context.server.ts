/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Shared header/identity resolution for every document. The business, property
 * and outlet block is identical across document types, so it is resolved once.
 */
import type { DocumentHeader } from "../core/types";

type Sb = any;

export async function documentHeader(
  sb: Sb,
  tenantId: string,
  propertyId?: string | null,
  locationId?: string | null,
): Promise<DocumentHeader> {
  const [{ data: tenant }, { data: property }, { data: location }] = await Promise.all([
    sb.from("restaurant_tenants").select("name, settings").eq("id", tenantId).maybeSingle(),
    propertyId
      ? sb.from("restaurant_properties").select("name, currency").eq("id", propertyId).maybeSingle()
      : Promise.resolve({ data: null }),
    locationId
      ? sb.from("restaurant_locations").select("name").eq("id", locationId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  return {
    business: tenant?.name ?? "Restaurant",
    property: property?.name ?? null,
    outlet: location?.name ?? null,
    address: (settings.address as string) ?? null,
    contact: (settings.contact as string) ?? null,
  };
}

export async function nameMap(sb: Sb, table: string, tenantId: string, column = "name") {
  const { data } = await sb.from(table).select(`id, ${column}`).eq("tenant_id", tenantId);
  return new Map(((data ?? []) as any[]).map((r) => [r.id as string, String(r[column] ?? "")]));
}

export const nowIso = () => new Date().toISOString();