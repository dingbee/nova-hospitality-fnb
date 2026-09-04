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
 *
 * O12 — the table id proves "this is a real, active table", nothing more.
 * It does not prove a dining session is currently, legitimately in
 * progress there, so it must not double as a permanent bearer credential
 * for *placing new orders*. `restaurant_guest_sessions` (0018) is that
 * missing, minimal concept: a server-issued, table-bound, time-boxed
 * session that gates only `submitGuestOrder`. Every other guest action
 * (tracking/payment/bill/staff/feedback) is already safely scoped by an
 * unguessable orderId + tenant/table re-derivation and is deliberately left
 * unchanged — recovering or paying an order a guest already placed must
 * never require re-proving a live session (see selforder-recovery.ts).
 */
import { fetchSellableCatalog } from "../sales/pos.server";
import { createGuestOrder, recalcOrder, type SalesLineInput } from "../sales/sales.server";
import { fireGuestOrder } from "../kitchen/kitchen.server";
import type { GuestLineInput } from "./selforder.contracts";

type Sb = any;

/**
 * Rolling idle window: a session stays valid as long as the guest places at
 * least one order within this window of their last one, refreshed on every
 * accepted order. Long enough that a guest who steps away for a few minutes
 * (bathroom, smoke break, chasing a kid) never loses the ordering
 * experience; short enough that a table photographed and abandoned hours or
 * days earlier cannot silently resume placing orders.
 */
const GUEST_SESSION_DURATION_MS = 3 * 60 * 60 * 1000;

const GUEST_SESSION_TABLE_OCCUPIED_MESSAGE =
  "This table already has a dining session in progress. If this is your table, please ask a member of staff for help.";

/** Same shape as receipts/delivery.server.ts's token() — 32 bytes of crypto randomness, hex-encoded. Never derived from, or predictable from, the table id. */
function generateGuestSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type GuestTableContext = {
  tableId: string;
  tableCode: string;
  tableName: string;
  tenantId: string;
  tenantName: string;
  /**
   * The name a guest should actually be welcomed by — settings.business.
   * tradingName when the operator has configured one (the existing "doing
   * business as" field surfaced in BusinessPanel.tsx, e.g. legal name "X
   * Hospitality Ltd" vs. trading name "Baobab Grove Lodge"), falling back to
   * tenantName otherwise. No new setup field: this reads a field that
   * already exists and is already editable by staff today.
   */
  businessName: string;
  /**
   * GEP4 — settings.business.logoUrl, the same canonical field
   * BusinessPanel.tsx's logo uploader writes and TopBar reads for POS.
   * Null when the operator hasn't configured a logo; every guest surface
   * must render gracefully without one.
   */
  businessLogoUrl: string | null;
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
    .select("id, name, status, settings")
    .eq("id", table.tenant_id)
    .maybeSingle();
  if (!tenant || tenant.status !== "active") {
    throw new Error("This table is not available for ordering.");
  }
  const business = (
    tenant.settings as { business?: { tradingName?: string; logoUrl?: string | null } } | null
  )?.business;
  const tradingName = (business?.tradingName ?? "").trim();
  const businessLogoUrl = business?.logoUrl?.trim() || null;
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
    businessName: tradingName || tenant.name,
    businessLogoUrl,
    propertyId: table.property_id ?? null,
    locationId: table.location_id ?? null,
    currency,
  };
}

/**
 * The sole write path that creates or reuses a guest dining session. Called
 * only from `submitGuestOrder`, immediately before a new order is written.
 *
 * - A presented token that matches an *active, unexpired* session on this
 *   exact table is reused and its expiry rolled forward — the ordinary
 *   "same guest, same table, next order" path.
 * - A presented token that doesn't match (wrong table, expired, closed, or
 *   simply absent — a fresh scan, a different device, or a photographed QR
 *   opened without ever carrying a session) is treated identically to no
 *   token at all: it grants nothing. If another session is already active
 *   on this table, the request is refused — a QR the guest kept does not
 *   let them attach a new order to a session they didn't start. If the
 *   table is free, a brand-new session is created — the same physical QR
 *   remains reusable for the next legitimate guest (old session != new
 *   session), with no need to ever rotate the QR itself.
 * - The database's partial unique index on (table_id) where status='active'
 *   is the actual race-safety backstop if two requests land at once; the
 *   pre-check here just gives a clean, hospitality-worded refusal instead
 *   of a constraint-violation error in the common case.
 */
export async function resolveOrStartGuestSession(
  sb: Sb,
  table: GuestTableContext,
  presentedToken: string | null | undefined,
): Promise<string> {
  const now = new Date();
  const nowIso = now.toISOString();

  // Lazily expire any stale 'active' row for this table before deciding
  // anything — there is no background job; expiry is enforced at the point
  // a new decision needs to be made.
  await sb
    .from("restaurant_guest_sessions")
    .update({ status: "expired" })
    .eq("table_id", table.tableId)
    .eq("status", "active")
    .lt("expires_at", nowIso);

  if (presentedToken) {
    const { data: existing } = await sb
      .from("restaurant_guest_sessions")
      .select("id, expires_at")
      .eq("token", presentedToken)
      .eq("table_id", table.tableId)
      .eq("status", "active")
      .maybeSingle();
    if (existing && new Date(existing.expires_at) > now) {
      const expiresAt = new Date(now.getTime() + GUEST_SESSION_DURATION_MS).toISOString();
      await sb
        .from("restaurant_guest_sessions")
        .update({ last_activity_at: nowIso, expires_at: expiresAt })
        .eq("id", existing.id);
      return presentedToken;
    }
  }

  const { data: blocking } = await sb
    .from("restaurant_guest_sessions")
    .select("id")
    .eq("table_id", table.tableId)
    .eq("status", "active")
    .maybeSingle();
  if (blocking) {
    throw new Error(GUEST_SESSION_TABLE_OCCUPIED_MESSAGE);
  }

  const token = generateGuestSessionToken();
  const expiresAt = new Date(now.getTime() + GUEST_SESSION_DURATION_MS).toISOString();
  const { error } = await sb.from("restaurant_guest_sessions").insert({
    tenant_id: table.tenantId,
    property_id: table.propertyId,
    location_id: table.locationId,
    table_id: table.tableId,
    token,
    status: "active",
    started_at: nowIso,
    last_activity_at: nowIso,
    expires_at: expiresAt,
  });
  if (error) {
    // The partial unique index caught a race the pre-check above missed —
    // another request just won the same table. Same refusal either way.
    throw new Error(GUEST_SESSION_TABLE_OCCUPIED_MESSAGE);
  }
  return token;
}

/**
 * Closes any active guest session for a table. Called from the existing
 * canonical points where a table is handed back — `releaseTable`
 * (bill.server.ts, order closed and settled) and the table-release-on-
 * cancel path (cancellation.server.ts) — never from a new, invented
 * checkout state. Best-effort: a session row failing to close must never
 * block the table release itself, which is the operationally important
 * side effect.
 */
export async function closeActiveGuestSession(
  sb: Sb,
  tableId: string,
  reason: string,
): Promise<void> {
  try {
    await sb
      .from("restaurant_guest_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString(), closed_reason: reason })
      .eq("table_id", tableId)
      .eq("status", "active");
  } catch {
    // Best-effort — see doc comment.
  }
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
  input: {
    tableId: string;
    guestName?: string;
    lines: GuestLineInput[];
    sessionToken?: string;
    /**
     * GEP3 — double-submission protection. Kept stable by the client across
     * retries of the *same* confirm attempt (double-tap, network retry, a
     * refresh mid-submission — see selforder-recovery.ts's
     * readStoredClientRequestId), and regenerated only once an order has
     * actually been created. A presented id that already resolved to a
     * real order for this exact table short-circuits straight back to that
     * order — never a second one, and never touches the sellable catalogue
     * or fires anything a second time.
     */
    clientRequestId?: string;
  },
) {
  const table = await resolveGuestTableContext(sb, input.tableId);

  if (input.clientRequestId) {
    const { data: existing } = await sb
      .from("restaurant_orders")
      .select("id, order_number, currency, table_id")
      .eq("tenant_id", table.tenantId)
      .eq("client_request_id", input.clientRequestId)
      .maybeSingle();
    if (existing) {
      if (existing.table_id !== table.tableId) {
        // A clientRequestId is only ever generated for one table's basket;
        // a mismatch can only mean a stale/tampered id, never a legitimate
        // retry — fail closed rather than ever handing back another
        // table's order.
        throw new Error("This order could not be found for this table.");
      }
      const sessionToken = await resolveOrStartGuestSession(sb, table, input.sessionToken);
      return {
        ...existing,
        ...(await recalcOrder(sb, table.tenantId, existing.id)),
        guestSessionToken: sessionToken,
        idempotent: true,
      };
    }
  }

  const sessionToken = await resolveOrStartGuestSession(sb, table, input.sessionToken);
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

  // unitPrice/discount/modifiers[].priceDelta are carried through here only
  // as values on the wire — none of them are money-authoritative.
  // createGuestOrder calls insertLines with `trusted: false`, which forces
  // strict pricing for every catalogued line (unitPrice/tax always
  // recomputed from the rule set), ignores this discount entirely (a guest
  // order's only discount is whatever active promotions the rule set grants
  // automatically), and re-resolves every modifier's name/priceDelta from
  // its own configured row rather than trusting this snapshot. See
  // insertLines' `trusted` doc comment in sales.server.ts for the full
  // guest-vs-staff trust boundary.
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
    clientRequestId: input.clientRequestId ?? null,
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
  //
  // GEP3: skipped when createGuestOrder recovered a concurrent request's
  // winning order (order.idempotent) rather than creating this one — that
  // request already fires it. fireGuestOrder is itself idempotent (only
  // items still "ordered" are fired; a second call on the same order finds
  // nothing left and returns {fired: 0}), so this is a belt-and-suspenders
  // skip, not a correctness requirement.
  if (!order.idempotent) {
    await fireGuestOrder(sb, { tenantId: table.tenantId, orderId: order.id });
  }

  // Additive: every existing field on `order` is untouched, so any caller
  // reading order.id/order_number/total keeps working unchanged. Only a new
  // consumer (order.$tableId.tsx) needs to look at guestSessionToken.
  return { ...order, guestSessionToken: sessionToken };
}
