/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I12 — independent, server-side entity re-verification.
 *
 * Per spec section 7: I11's resolvedId is never trusted merely because a
 * NovaIntentContract says so. Every id that will end up in a prepared
 * workflow payload is re-fetched here, scoped to the caller's own tenant
 * and to an active status — a stale, foreign, or (in principle) tampered
 * id fails a fresh, real lookup rather than being taken on faith.
 */
type Sb = any;

export interface VerifiedInventoryItem {
  id: string;
  name: string;
  unitId: string | null;
}

export async function verifyInventoryItem(
  sb: Sb,
  tenantId: string,
  id: string,
): Promise<VerifiedInventoryItem | null> {
  const { data } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, unit_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.name, unitId: data.unit_id ?? null };
}

export interface VerifiedLocation {
  id: string;
  name: string;
  locationType: string | null;
}

export async function verifyLocation(
  sb: Sb,
  tenantId: string,
  id: string,
): Promise<VerifiedLocation | null> {
  const { data } = await sb
    .from("restaurant_locations")
    .select("id, name, location_type")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.name, locationType: data.location_type ?? null };
}

export interface VerifiedSupplier {
  id: string;
  name: string;
}

export async function verifySupplier(
  sb: Sb,
  tenantId: string,
  id: string,
): Promise<VerifiedSupplier | null> {
  const { data } = await sb
    .from("restaurant_suppliers")
    .select("id, name")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.name };
}

export interface VerifiedUnit {
  id: string;
  code: string;
}

export async function verifyUnit(
  sb: Sb,
  tenantId: string,
  id: string,
): Promise<VerifiedUnit | null> {
  const { data } = await sb
    .from("restaurant_inventory_units")
    .select("id, code")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return { id: data.id, code: data.code };
}

/** The tenant's own configured currency, never a hardcoded literal — reused so a prepared purchase request lands in the currency the tenant actually operates in. */
export async function resolveTenantCurrency(sb: Sb, tenantId: string): Promise<string> {
  const { data } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", tenantId)
    .maybeSingle();
  const currency = (data?.settings as any)?.business?.defaultCurrency;
  return typeof currency === "string" && currency.trim().length === 3 ? currency : "TZS";
}
