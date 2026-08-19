/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial readiness audit.
 *
 * This is a *read-only mirror* of what the POS will do. It asks the very same
 * engine, through the very same rule loader, whether each sellable item would
 * resolve to a price right now. It never writes a price, never invents a
 * default, and never "fixes" anything: an item without a configured price is
 * reported as not ready, because selling it would be a governance failure, not
 * a rounding detail.
 */
import { assertTenantRead } from "../core/access.server";
import { CommercialRuleError, type PricingContext } from "./engine";
import { loadRuleSet, quoteWithRuleSet } from "./resolution.server";

type Sb = any;

export type ReadinessRow = {
  menuItemId: string;
  name: string;
  menuName: string;
  menuStatus: string;
  locationId: string | null;
  locationName: string;
  propertyId: string | null;
  channel: string;
  ready: boolean;
  reason: string | null;
  currency: string | null;
  unitPrice: number | null;
  priceSource: string | null;
  priceListId: string | null;
  /** The legacy per-item price kept on the menu row, for comparison only. */
  menuCardPrice: number | null;
  /** True when the menu card and the resolved commercial price disagree. */
  divergent: boolean;
};

export type ReadinessReport = {
  generatedAt: string;
  channel: string;
  total: number;
  ready: number;
  blocked: number;
  divergent: number;
  rulesInForce: {
    prices: number;
    priceLists: number;
    taxes: number;
    serviceCharges: number;
    promotions: number;
    roundingRules: number;
  };
  rows: ReadinessRow[];
};

/**
 * Sellable = an available item on a published menu. Draft and archived menus
 * are deliberately excluded: they are not offered to a guest, so a missing
 * price there is not a blocker.
 */
export async function pricingReadiness(
  sb: Sb,
  userId: string,
  input: { tenantId: string; channel?: string; limit?: number },
): Promise<ReadinessReport> {
  await assertTenantRead(sb, userId, input.tenantId);
  const channel = input.channel ?? "dine_in";
  const limit = Math.min(input.limit ?? 500, 1000);

  const { data: menuRows } = await sb
    .from("restaurant_menus")
    .select("id, name, status, property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("status", "published");
  const menus = (menuRows ?? []) as any[];

  if (menus.length === 0) {
    return emptyReport(channel, {
      prices: 0,
      priceLists: 0,
      taxes: 0,
      serviceCharges: 0,
      promotions: 0,
      roundingRules: 0,
    });
  }

  const { data: itemRows } = await sb
    .from("restaurant_menu_items")
    .select("id, name, menu_id, price, currency, available, lifecycle_status, category_id")
    .eq("tenant_id", input.tenantId)
    .in(
      "menu_id",
      menus.map((m) => m.id),
    )
    .eq("available", true)
    .is("archived_at", null)
    .limit(limit);
  const items = (itemRows ?? []) as any[];

  const locationIds = [...new Set(menus.map((m) => m.location_id).filter(Boolean))];
  const { data: locationRows } = locationIds.length
    ? await sb
        .from("restaurant_locations")
        .select("id, name")
        .eq("tenant_id", input.tenantId)
        .in("id", locationIds)
    : { data: [] };
  const locations = new Map(((locationRows ?? []) as any[]).map((l) => [l.id as string, l.name as string]));

  const rules = await loadRuleSet(sb, input.tenantId, { menuItemIds: items.map((i) => i.id) });
  const at = new Date();
  const menuById = new Map(menus.map((m) => [m.id as string, m]));

  const rows: ReadinessRow[] = items.map((item) => {
    const menu = menuById.get(item.menu_id);
    const ctx: PricingContext = {
      at,
      propertyId: menu?.property_id ?? null,
      locationId: menu?.location_id ?? null,
      productId: null,
      variantId: null,
      menuItemId: item.id,
      categoryId: item.category_id ?? null,
      orderType: channel as any,
      channel,
      priceListIds: [],
      quantity: 1,
    };
    const base = {
      menuItemId: item.id as string,
      name: (item.name as string) ?? "Item",
      menuName: (menu?.name as string) ?? "—",
      menuStatus: (menu?.status as string) ?? "—",
      locationId: (menu?.location_id as string) ?? null,
      locationName: menu?.location_id ? (locations.get(menu.location_id) ?? "Outlet") : "All outlets",
      propertyId: (menu?.property_id as string) ?? null,
      channel,
      menuCardPrice: item.price == null ? null : Number(item.price),
    };
    try {
      // strict: exactly the POS contract — a catalogued item must be priced by
      // a rule, never by whatever number happens to sit on the menu row.
      const quote = quoteWithRuleSet(rules, ctx, { strict: true });
      const divergent =
        base.menuCardPrice != null &&
        Math.abs(base.menuCardPrice - quote.unitPrice) > 0.004 &&
        base.menuCardPrice > 0;
      return {
        ...base,
        ready: true,
        reason: null,
        currency: quote.currency,
        unitPrice: quote.unitPrice,
        priceSource: quote.priceSource,
        priceListId: quote.priceListId,
        divergent,
      };
    } catch (e) {
      const reason =
        e instanceof CommercialRuleError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Price could not be resolved.";
      return {
        ...base,
        ready: false,
        reason,
        currency: (item.currency as string) ?? null,
        unitPrice: null,
        priceSource: null,
        priceListId: null,
        divergent: false,
      };
    }
  });

  return {
    generatedAt: at.toISOString(),
    channel,
    total: rows.length,
    ready: rows.filter((r) => r.ready).length,
    blocked: rows.filter((r) => !r.ready).length,
    divergent: rows.filter((r) => r.divergent).length,
    rulesInForce: {
      prices: rules.prices.length,
      priceLists: rules.priceLists.length,
      taxes: rules.taxes.length,
      serviceCharges: rules.serviceCharges.length,
      promotions: rules.promotions.length,
      roundingRules: rules.roundingRules.length,
    },
    rows,
  };
}

function emptyReport(channel: string, rulesInForce: ReadinessReport["rulesInForce"]): ReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    channel,
    total: 0,
    ready: 0,
    blocked: 0,
    divergent: 0,
    rulesInForce,
    rows: [],
  };
}
