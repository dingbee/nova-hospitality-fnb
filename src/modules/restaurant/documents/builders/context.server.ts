/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Shared header/identity resolution for every document. The business, property
 * and outlet block is identical across document types, so it is resolved once.
 */
import type { DocumentHeader } from "../core/types";

type Sb = any;

/**
 * The one and only place an operational document resolves who issued it.
 * Restaurant Setup's Business Profile (BusinessPanel.tsx, settings.business)
 * is the authoritative source — the same field every other branded surface
 * already reads (selforder.server.ts's guest welcome, TopBar's POS logo).
 * This used to read the raw `restaurant_tenants.name` / non-existent
 * top-level `settings.address`/`settings.contact` keys instead, which is why
 * a real Purchase Order rendered the tenant's internal record name ("UAT
 * Tenant A (UAT)") instead of the configured trading identity — those flat
 * keys are never written by anything, so they were always empty or wrong.
 */
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
  const business = ((tenant?.settings as { business?: Record<string, unknown> } | null)?.business ??
    {}) as Record<string, unknown>;
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() || null : null);
  const tradingName = trim(business.tradingName);
  const legalName = trim(business.legalName);
  // Same precedence every other branded surface already uses (trading name
  // first) — never the tenant's own placeholder/legal record name unless
  // Restaurant Setup genuinely has nothing configured yet.
  const displayName = tradingName ?? legalName ?? tenant?.name ?? "Restaurant";
  const phone = trim(business.phone);
  const email = trim(business.email);
  return {
    business: displayName,
    legalName: legalName && legalName !== displayName ? legalName : null,
    property: property?.name ?? null,
    outlet: location?.name ?? null,
    address: trim(business.address),
    contact: [phone, email].filter(Boolean).join(" · ") || null,
    website: trim(business.website),
    taxId: trim(business.taxId),
    logoUrl: trim(business.logoUrl),
  };
}

export async function nameMap(sb: Sb, table: string, tenantId: string, column = "name") {
  const { data } = await sb.from(table).select(`id, ${column}`).eq("tenant_id", tenantId);
  return new Map(((data ?? []) as any[]).map((r) => [r.id as string, String(r[column] ?? "")]));
}

export const nowIso = () => new Date().toISOString();
