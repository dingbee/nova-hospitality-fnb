/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Customer self-ordering — the one write path in this codebase with no
 * staff principal behind it. Every other entry point into `insertLines`
 * (`createOrder`, `addOrderItems`, the POS) is reached through
 * `requireSupabaseAuth` + `assertCapability`/`assertTenantRead` against a
 * real `restaurant_members` row. A guest scanning a table has none of that,
 * so nothing here trusts the request for tenant, property, location, price,
 * or station: the table id is the only thing the client supplies, and every
 * other fact is re-derived from it, server-side, before a single row is
 * written. The pricing and station-routing authority itself is not
 * reimplemented — `insertLines` is called unchanged, exactly as the POS
 * calls it.
 */
import { fetchSellableCatalog } from "../sales/pos.server";
import { createGuestOrder, type SalesLineInput } from "../sales/sales.server";
import { fireGuestOrder } from "../kitchen/kitchen.server";
import type { GuestLineInput } from "./selforder.contracts";

type Sb = any;

export type GuestTableContext = {
  tableId: string;
  tableCode: string;
  tableName: string;
  tenantId: string;
  tenantName: string;
  propertyId: string | null;
  locationId: string | null;
  currency: string;
};

/**
 * Resolves a table id to the tenant/property/location it belongs to. This
 * is the sole authorization boundary for the whole guest surface: a table
 * that doesn't exist, or isn't active, is refused before any catalogue or
 * order data is ever touched. Nothing about tenant/property/location is
 * ever accepted from the client — it always comes from this lookup.
 */
export async function resolveGuestTableContext(
  sb: Sb,
  tableId: string,
): Promise<GuestTableContext> {
  const { data: table } = await sb
    .from("restaurant_tables")
    .select("id, code, name, tenant_id, property_id, location_id, active")
    .eq("id", tableId)
    .maybeSingle();
  if (!table || table.active === false) {
    throw new Error("This table is not available for ordering.");
  }
  const { data: tenant } = await sb
    .from("restaurant_tenants")
    .select("id, name, status")
    .eq("id", table.tenant_id)
    .maybeSingle();
  if (!tenant || tenant.status !== "active") {
    throw new Error("This table is not available for ordering.");
  }
  const currency = await (async () => {
    const { data } = await sb
      .from("restaurant_currencies")
      .select("code")
      .eq("tenant_id", table.tenant_id)
      .eq("is_base", true)
      .limit(1);
    return ((data ?? []) as any[])[0]?.code ?? "USD";
  })();

  return {
    tableId: table.id,
    tableCode: table.code,
    tableName: table.name,
    tenantId: table.tenant_id,
    tenantName: tenant.name,
    propertyId: table.property_id ?? null,
    locationId: table.location_id ?? null,
    currency,
  };
}

/** The public menu for the table's own tenant/location — nothing else is reachable from a table id. */
export async function guestMenu(sb: Sb, tableId: string) {
  const table = await resolveGuestTableContext(sb, tableId);
  const catalog = await fetchSellableCatalog(sb, table.tenantId, {
    propertyId: table.propertyId ?? undefined,
    locationId: table.locationId ?? undefined,
  });
  return {
    table,
    ...catalog,
    // A guest never sees an item staff have marked unavailable, or one the
    // pricing engine has no active price for — a price it would only refuse
    // at submission is never worth putting in front of a guest to tap.
    items: catalog.items.filter((i: any) => i.available !== false && i.priceConfigured !== false),
  };
}

/**
 * Splits a guest's proposed lines into what the resolved tenant's catalogue
 * can actually sell and what it can't — a `menuItemId` that doesn't belong
 * to this tenant, or isn't on a published/available menu, is rejected here
 * rather than reaching `insertLines`. Pure and DB-free so it can be unit
 * tested without a Supabase client.
 */
export function pickGuestOrderableLines(
  sellableMenuItemIds: ReadonlySet<string>,
  lines: readonly GuestLineInput[],
): { valid: GuestLineInput[]; rejected: GuestLineInput[] } {
  const valid: GuestLineInput[] = [];
  const rejected: GuestLineInput[] = [];
  for (const line of lines) {
    // An "open item" (no menuItemId) has no catalogue identity to validate,
    // but nothing about self-ordering should accept an operator-priced free
    // line from an unauthenticated caller, so it's rejected outright.
    if (!line.menuItemId || !sellableMenuItemIds.has(line.menuItemId)) {
      rejected.push(line);
      continue;
    }
    valid.push(line);
  }
  return { valid, rejected };
}

export async function submitGuestOrder(
  sb: Sb,
  input: { tableId: string; guestName?: string; lines: GuestLineInput[] },
) {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const catalog = await fetchSellableCatalog(sb, table.tenantId, {
    propertyId: table.propertyId ?? undefined,
    locationId: table.locationId ?? undefined,
  });
  const sellableIds = new Set(
    (catalog.items as any[])
      .filter((i) => i.available !== false && i.priceConfigured !== false)
      .map((i) => i.id as string),
  );

  const { valid, rejected } = pickGuestOrderableLines(sellableIds, input.lines);
  if (rejected.length > 0) {
    throw new Error(
      `${rejected.length} item(s) in this order are no longer available. Please refresh the menu and try again.`,
    );
  }
  if (valid.length === 0) {
    throw new Error("The order has no orderable items.");
  }

  // unitPrice/discount are the till's proposal fields too; insertLines only
  // ever honours them as a *proposal* for catalogued lines (strict pricing
  // recomputes unit_price/discount/tax from the rule set in force), so a
  // guest-supplied value here carries no more authority than the POS
  // sending one does. taxAmount is never client-supplied even at the POS
  // (pos.server.ts's toSalesLines hardcodes it to 0 too) — always
  // server-derived from the rule set.
  const salesLines: SalesLineInput[] = valid.map((l) => ({
    menuItemId: l.menuItemId,
    variantId: l.variantId,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    taxAmount: 0,
    notes: l.notes,
    guestNotes: l.guestNotes,
    modifiers: l.modifiers,
  }));

  const order = await createGuestOrder(sb, {
    tenantId: table.tenantId,
    propertyId: table.propertyId,
    locationId: table.locationId,
    tableId: table.tableId,
    guestName: input.guestName ?? null,
    currency: table.currency,
    lines: salesLines,
  });

  // A guest tapping "Send order" IS the send-to-kitchen action — there is no
  // separate staff review step in this flow, and the confirmation screen
  // already tells the guest their order is on its way. Without this, the
  // order sat at "open" until a staff member happened to notice and fire it
  // by hand, and the guest's own tracker never advanced past "received".
  // Best-effort: the order itself is already the record that matters, so a
  // firing hiccup here must never fail an order the guest already placed
  // successfully — it just leaves the order for a staff member to fire
  // manually, exactly like every order this path doesn't reach.
  await fireGuestOrder(sb, { tenantId: table.tenantId, orderId: order.id });

  return order;
}
