/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Order property/location scope resolution — the staff-side counterpart to
 * `selforder.server.ts`'s `resolveGuestTableContext`.
 *
 * P0 finding: `createOrder`/`openPosOrder` used to write `propertyId`/
 * `locationId` straight from client input, with no check that they agreed
 * with the table those lines were actually being rung against — so a client
 * could open an order against a real table while claiming a different
 * property's scope, and every downstream pricing/routing decision (which
 * reads the order's own property/location, not the table's) would follow
 * the forged claim.
 *
 * The fix mirrors the guest path exactly: when a table is given, the
 * table's own row is the sole source of truth for property/location —
 * whatever the caller separately claimed is ignored. Only a genuinely
 * table-less order (phone/delivery/takeaway with no physical table) falls
 * back to the caller's own claim, in which case the caller must still hold
 * the capability at that property (see access.server.ts's scope-aware
 * assertCapability).
 */
type Sb = any;

export async function resolveOrderScope(
  sb: Sb,
  tenantId: string,
  input: { tableId?: string | null; propertyId?: string | null; locationId?: string | null },
): Promise<{ propertyId: string | null; locationId: string | null }> {
  if (input.tableId) {
    const { data: table } = await sb
      .from("restaurant_tables")
      .select("id, tenant_id, property_id, location_id")
      .eq("id", input.tableId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!table) throw new Error("This table does not belong to this tenant.");
    return { propertyId: table.property_id ?? null, locationId: table.location_id ?? null };
  }
  return { propertyId: input.propertyId ?? null, locationId: input.locationId ?? null };
}
