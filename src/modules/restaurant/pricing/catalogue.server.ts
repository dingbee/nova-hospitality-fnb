/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Pricing Centre operator workspace — read-only aggregation.
 *
 * The item registry stays exactly where it already was: restaurant_menu_items
 * / restaurant_menus / restaurant_categories. Recipe cost stays exactly
 * where it already was: restaurant_recipes, resolved by the same
 * product → recipe → active-lineage-version precedence
 * recipes.server.ts's activeRecipeForMenuItem uses at order time (batched
 * here for a catalogue-sized read instead of once per line). The
 * authoritative price stays exactly where it already was: the same
 * loadRuleSet/resolveBasePrice engine POS, guest ordering and Readiness all
 * read. Nothing here is a second source of truth — it is one screen that
 * cross-references three sources that already existed.
 */
import { assertTenantRead } from "../core/access.server";
import { candidatesFor, loadRuleSet } from "./resolution.server";
import { resolveBasePrice, type PriceCandidate, type PricingContext } from "./engine";
import type { PricingCatalogueInput, PricingState } from "./contracts";

type Sb = any;

export type PricingCatalogueRow = {
  menuItemId: string;
  name: string;
  menuId: string;
  menuName: string;
  menuStatus: string;
  categoryId: string | null;
  categoryName: string | null;
  available: boolean;
  currency: string | null;
  menuCardPrice: number | null;
  recipeCost: number | null;
  activePrice: {
    amount: number;
    currency: string;
    priceId: string;
    scope: string;
    version: number;
  } | null;
  pendingPrice: { amount: number; currency: string; priceId: string } | null;
  scheduledPrice: {
    amount: number;
    currency: string;
    priceId: string;
    effectiveFrom: string;
  } | null;
  marginPercent: number | null;
  foodCostPercent: number | null;
  state: PricingState;
};

export type PricingCatalogueResult = {
  generatedAt: string;
  channel: string;
  total: number;
  rows: PricingCatalogueRow[];
};

/**
 * Batched mirror of recipes.server.ts's activeRecipeForMenuItem: same
 * precedence (active product's pinned recipe → that recipe's lineage's
 * current active version → the pinned recipe itself if it is the active
 * one), done in four queries total instead of two-to-three per item, since
 * this reads the whole catalogue at once rather than one order's lines.
 */
async function batchRecipeCosts(
  sb: Sb,
  tenantId: string,
  menuItemIds: string[],
): Promise<Map<string, number>> {
  const costs = new Map<string, number>();
  if (menuItemIds.length === 0) return costs;

  const { data: productRows } = await sb
    .from("restaurant_products")
    .select("id, menu_item_id, recipe_id")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .not("recipe_id", "is", null)
    .in("menu_item_id", menuItemIds);
  const products = (productRows ?? []) as any[];
  if (products.length === 0) return costs;

  const pinnedRecipeIds = [...new Set(products.map((p) => p.recipe_id as string))];
  const { data: pinnedRows } = await sb
    .from("restaurant_recipes")
    .select("id, lineage_id, version, status")
    .eq("tenant_id", tenantId)
    .in("id", pinnedRecipeIds);
  const pinnedById = new Map(((pinnedRows ?? []) as any[]).map((r) => [r.id as string, r]));

  const lineageIds = [
    ...new Set(Array.from(pinnedById.values()).map((r: any) => (r.lineage_id ?? r.id) as string)),
  ];
  const { data: activeRows } = lineageIds.length
    ? await sb
        .from("restaurant_recipes")
        .select("id, lineage_id, version, computed_cost")
        .eq("tenant_id", tenantId)
        .in("lineage_id", lineageIds)
        .eq("status", "active")
        .order("version", { ascending: false })
    : { data: [] as any[] };
  const activeByLineage = new Map<string, any>();
  for (const r of (activeRows ?? []) as any[]) {
    if (!activeByLineage.has(r.lineage_id)) activeByLineage.set(r.lineage_id, r);
  }

  const fallbackIds = [...pinnedById.values()]
    .filter((r: any) => r.status === "active" && !activeByLineage.has(r.lineage_id ?? r.id))
    .map((r: any) => r.id as string);
  const { data: fallbackRows } = fallbackIds.length
    ? await sb
        .from("restaurant_recipes")
        .select("id, computed_cost")
        .eq("tenant_id", tenantId)
        .in("id", fallbackIds)
    : { data: [] as any[] };
  const fallbackById = new Map(
    ((fallbackRows ?? []) as any[]).map((r) => [r.id as string, Number(r.computed_cost ?? 0)]),
  );

  for (const p of products) {
    const pinned = pinnedById.get(p.recipe_id);
    if (!pinned) continue;
    const lineage = pinned.lineage_id ?? pinned.id;
    const active = activeByLineage.get(lineage);
    const cost = active ? Number(active.computed_cost ?? 0) : fallbackById.get(pinned.id);
    if (cost != null) costs.set(p.menu_item_id, cost);
  }
  return costs;
}

/** A stored price row matches the operator's current scope/channel/price-list filter exactly the same way upsertPrice's own "current" lookup does. */
function matchesFilterScope(
  r: {
    propertyId: string | null;
    locationId: string | null;
    priceListId?: string | null;
    channel?: string | null;
  },
  input: PricingCatalogueInput,
): boolean {
  return (
    (input.propertyId ? r.propertyId === input.propertyId : r.propertyId === null) &&
    (input.locationId ? r.locationId === input.locationId : r.locationId === null) &&
    (input.priceListId ? r.priceListId === input.priceListId : !r.priceListId) &&
    (r.channel === input.channel || !r.channel)
  );
}

export async function pricingCatalogue(
  sb: Sb,
  userId: string,
  input: PricingCatalogueInput,
): Promise<PricingCatalogueResult> {
  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const at = new Date();
  const empty = (): PricingCatalogueResult => ({
    generatedAt: at.toISOString(),
    channel: input.channel,
    total: 0,
    rows: [],
  });

  let menuQuery = sb
    .from("restaurant_menus")
    .select("id, name, status, property_id, location_id")
    .eq("tenant_id", input.tenantId);
  if (input.propertyId) menuQuery = menuQuery.eq("property_id", input.propertyId);
  if (input.locationId) menuQuery = menuQuery.eq("location_id", input.locationId);
  if (input.menuId) menuQuery = menuQuery.eq("id", input.menuId);
  const { data: menuRows } = await menuQuery;
  const menus = (menuRows ?? []) as any[];
  if (menus.length === 0) return empty();
  const menuById = new Map(menus.map((m) => [m.id as string, m]));

  let itemQuery = sb
    .from("restaurant_menu_items")
    .select("id, name, menu_id, category_id, price, currency, available")
    .eq("tenant_id", input.tenantId)
    .is("archived_at", null)
    .in(
      "menu_id",
      menus.map((m) => m.id),
    )
    .order("name")
    .limit(input.limit);
  if (input.categoryId) itemQuery = itemQuery.eq("category_id", input.categoryId);
  if (input.search) itemQuery = itemQuery.ilike("name", `%${input.search}%`);
  if (input.menuItemIds && input.menuItemIds.length > 0)
    itemQuery = itemQuery.in("id", input.menuItemIds);
  const { data: itemRows } = await itemQuery;
  const items = (itemRows ?? []) as any[];
  if (items.length === 0) return empty();

  const categoryIds = [...new Set(items.map((i) => i.category_id).filter(Boolean))];
  const { data: categoryRows } = categoryIds.length
    ? await sb
        .from("restaurant_categories")
        .select("id, name")
        .eq("tenant_id", input.tenantId)
        .in("id", categoryIds)
    : { data: [] as any[] };
  const categoryName = new Map(
    ((categoryRows ?? []) as any[]).map((c) => [c.id as string, c.name as string]),
  );

  const menuItemIds = items.map((i) => i.id as string);
  const rules = await loadRuleSet(sb, input.tenantId, { menuItemIds });
  const recipeCosts = await batchRecipeCosts(sb, input.tenantId, menuItemIds);

  const { data: draftRows } = await sb
    .from("restaurant_prices")
    .select(
      "id, menu_item_id, amount, currency, status, effective_from, property_id, location_id, channel, price_list_id",
    )
    .eq("tenant_id", input.tenantId)
    .in("menu_item_id", menuItemIds)
    .in("status", ["pending_approval", "draft"]);
  const draftByItem = new Map<string, any[]>();
  for (const r of (draftRows ?? []) as any[]) {
    draftByItem.set(r.menu_item_id, [...(draftByItem.get(r.menu_item_id) ?? []), r]);
  }

  const rows: PricingCatalogueRow[] = items.map((item) => {
    const menu = menuById.get(item.menu_id);
    const ctx: PricingContext = {
      at,
      propertyId: input.propertyId ?? menu?.property_id ?? null,
      locationId: input.locationId ?? menu?.location_id ?? null,
      productId: null,
      variantId: null,
      menuItemId: item.id,
      categoryId: item.category_id ?? null,
      orderType: input.channel,
      channel: input.channel,
      priceListIds: input.priceListId ? [input.priceListId] : [],
      quantity: 1,
    };
    const scoped: PriceCandidate[] = candidatesFor(rules, ctx);
    let winner: PriceCandidate | null = null;
    try {
      winner = resolveBasePrice(scoped, ctx, rules.priceLists);
    } catch {
      // Two equally-valid active prices for the same scope — a genuine
      // configuration conflict. Surface as "no resolvable price" here; the
      // conflict itself is visible in the price history / audit trail.
      winner = null;
    }

    const futureActive = scoped.find(
      (p) =>
        p.status === "active" &&
        new Date(p.effectiveFrom).getTime() > at.getTime() &&
        matchesFilterScope(
          {
            propertyId: p.propertyId,
            locationId: p.locationId,
            priceListId: p.priceListId,
            channel: p.channel,
          },
          input,
        ),
    );
    const scheduledPrice = futureActive
      ? {
          amount: futureActive.amount,
          currency: futureActive.currency,
          priceId: futureActive.id,
          effectiveFrom: futureActive.effectiveFrom,
        }
      : null;

    const pending = (draftByItem.get(item.id) ?? [])
      .filter((r) =>
        matchesFilterScope(
          {
            propertyId: r.property_id,
            locationId: r.location_id,
            priceListId: r.price_list_id,
            channel: r.channel,
          },
          input,
        ),
      )
      .find((r) => r.status === "pending_approval");

    let state: PricingState;
    if (winner) state = "active";
    else if (pending) state = "pending_approval";
    else if (scheduledPrice) state = "scheduled";
    else state = "no_price";

    const recipeCost = recipeCosts.has(item.id) ? recipeCosts.get(item.id)! : null;
    const marginPercent =
      winner && winner.amount > 0 && recipeCost != null
        ? Number((((winner.amount - recipeCost) / winner.amount) * 100).toFixed(1))
        : null;
    const foodCostPercent =
      winner && winner.amount > 0 && recipeCost != null
        ? Number(((recipeCost / winner.amount) * 100).toFixed(1))
        : null;

    return {
      menuItemId: item.id as string,
      name: (item.name as string) ?? "Item",
      menuId: item.menu_id as string,
      menuName: (menu?.name as string) ?? "—",
      menuStatus: (menu?.status as string) ?? "—",
      categoryId: (item.category_id as string) ?? null,
      categoryName: item.category_id ? (categoryName.get(item.category_id) ?? null) : null,
      available: Boolean(item.available),
      currency: winner?.currency ?? (item.currency as string) ?? null,
      menuCardPrice: item.price == null ? null : Number(item.price),
      recipeCost,
      activePrice: winner
        ? {
            amount: winner.amount,
            currency: winner.currency,
            priceId: winner.id,
            scope: winner.scope,
            version: winner.version,
          }
        : null,
      pendingPrice: pending
        ? { amount: Number(pending.amount), currency: pending.currency, priceId: pending.id }
        : null,
      scheduledPrice,
      marginPercent,
      foodCostPercent,
      state,
    };
  });

  const filtered = input.status ? rows.filter((r) => r.state === input.status) : rows;
  return {
    generatedAt: at.toISOString(),
    channel: input.channel,
    total: filtered.length,
    rows: filtered,
  };
}
