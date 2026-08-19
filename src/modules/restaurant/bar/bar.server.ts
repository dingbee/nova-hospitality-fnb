/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Bar Operations service (Sprint 5.6). Server-only.
 *
 * Everything here is a *read* over the existing architecture (locations,
 * stations, kitchen tickets, requisitions, transfers, batches, order items,
 * stock movements, stocktakes) plus two genuinely new writes:
 *   1. pour configuration on an existing inventory item
 *   2. complimentary marking on an existing order item
 *
 * No balance is ever written here. No parallel POS, ledger, recipe or costing
 * engine exists in this file.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { UnitRow } from "../inventory/units";
import { pourCost as computePourCost, pourMaths, poursAvailable, round6 } from "./pour";
import {
  BAR_LOCATION_TYPES,
  BAR_STATION_TYPES,
  type BarBeverage,
  type BarSnapshot,
  type BarSnapshotInput,
  type BarVarianceRow,
  type BeverageVarianceInput,
  type CompDrinkInput,
  type FlagVarianceInput,
  type ListBeveragesInput,
  type SavePourConfigInput,
} from "./contracts";

type Sb = any;

const OPEN_TICKET_STATUSES = ["queued", "preparing", "ready"];
const OPEN_REQUISITION_STATUSES = ["submitted", "approved", "partially_issued"];
const OPEN_TRANSFER_STATUSES = ["requested", "approved", "dispatched", "partially_received"];

async function unitMap(sb: Sb, tenantId: string): Promise<Map<string, UnitRow>> {
  const { data } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, name, dimension, factor, base_unit_id")
    .eq("tenant_id", tenantId);
  return new Map(((data ?? []) as UnitRow[]).map((u) => [u.id, u]));
}

/** Locations and stations that constitute "the bar" for this tenant. */
export async function resolveBarScope(sb: Sb, tenantId: string, propertyId?: string) {
  let locQuery = sb
    .from("restaurant_locations")
    .select("id, name, location_type, parent_id, is_storage, status")
    .eq("tenant_id", tenantId)
    .order("name");
  if (propertyId) locQuery = locQuery.eq("property_id", propertyId);
  const { data: locs } = await locQuery;
  const all = (locs ?? []) as any[];

  const barTypes = new Set<string>(BAR_LOCATION_TYPES as readonly string[]);
  const bars = all.filter((l) => barTypes.has(String(l.location_type)));
  const barIds = new Set(bars.map((l) => l.id));
  // A store parented to a bar (e.g. "Pool Bar Store") belongs to that bar.
  const barStores = all.filter((l) => l.parent_id && barIds.has(l.parent_id) && !barIds.has(l.id));
  const scopeLocations = [...bars, ...barStores];
  const scopeIds = scopeLocations.map((l) => l.id);

  let stationQuery = sb
    .from("restaurant_stations")
    .select("id, name, station_type, location_id, target_prep_minutes, active")
    .eq("tenant_id", tenantId)
    .order("sort_order");
  if (propertyId) stationQuery = stationQuery.eq("property_id", propertyId);
  const { data: stationRows } = await stationQuery;
  const stationTypes = new Set<string>(BAR_STATION_TYPES as readonly string[]);
  const stations = ((stationRows ?? []) as any[]).filter(
    (s) => stationTypes.has(String(s.station_type)) || (s.location_id && scopeIds.includes(s.location_id)),
  );

  return {
    allLocations: all,
    locations: scopeLocations.map((l) => ({
      id: l.id,
      name: l.name,
      locationType: l.location_type,
      parentId: l.parent_id ?? null,
      isStorage: Boolean(l.is_storage),
    })),
    locationIds: scopeIds,
    stations: stations.map((s) => ({
      id: s.id,
      name: s.name,
      stationType: s.station_type,
      locationId: s.location_id ?? null,
      targetPrepMinutes: s.target_prep_minutes ?? null,
      active: s.active !== false,
    })),
    stationIds: stations.map((s) => s.id),
  };
}

export async function getBarSnapshot(sb: Sb, userId: string, input: BarSnapshotInput): Promise<BarSnapshot> {
  await assertTenantRead(sb, userId, input.tenantId);
  const scope = await resolveBarScope(sb, input.tenantId, input.propertyId);
  const stationIds = scope.stationIds;
  const locationIds = input.locationId ? [input.locationId] : scope.locationIds;
  const stationName = new Map(scope.stations.map((s) => [s.id, s.name]));

  /* Tickets — existing kitchen/service ticket architecture, bar stations only. */
  let tickets: any[] = [];
  if (stationIds.length > 0) {
    const { data } = await sb
      .from("restaurant_kitchen_tickets")
      .select("id, ticket_number, station_id, status, queued_at, started_at, ready_at, served_at, is_delayed, target_minutes, notes")
      .eq("tenant_id", input.tenantId)
      .in("station_id", stationIds)
      .in("status", OPEN_TICKET_STATUSES)
      .order("queued_at", { ascending: true })
      .limit(60);
    tickets = (data ?? []) as any[];
  }
  const now = Date.now();

  /* Bar requisitions — the existing requisition engine, kind = bar. */
  const { data: reqs } = await sb
    .from("restaurant_requisitions")
    .select("id, reference, status, created_at")
    .eq("tenant_id", input.tenantId)
    .eq("kind", "bar")
    .in("status", OPEN_REQUISITION_STATUSES)
    .order("created_at", { ascending: false })
    .limit(20);

  /* Transfers heading into the bar. */
  let transfers: any[] = [];
  if (locationIds.length > 0) {
    const { data } = await sb
      .from("restaurant_stock_transfers")
      .select("id, transfer_number, status, created_at, destination_location_id")
      .eq("tenant_id", input.tenantId)
      .in("destination_location_id", locationIds)
      .in("status", OPEN_TRANSFER_STATUSES)
      .order("created_at", { ascending: false })
      .limit(20);
    transfers = (data ?? []) as any[];
  }

  /* Beverage stock. */
  const { data: items } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, current_quantity, reorder_point, is_beverage, item_type, currency")
    .eq("tenant_id", input.tenantId)
    .or("is_beverage.eq.true,item_type.eq.beverage")
    .limit(500);
  const beverages = (items ?? []) as any[];
  const lowStock = beverages
    .filter((i) => i.reorder_point != null && Number(i.current_quantity) <= Number(i.reorder_point))
    .map((i) => ({
      itemId: i.id,
      name: i.name,
      onHand: Number(i.current_quantity ?? 0),
      reorderPoint: i.reorder_point == null ? null : Number(i.reorder_point),
    }));

  /* Expiring batches for beverages. */
  const horizon = new Date(now + 14 * 86400000).toISOString().slice(0, 10);
  const bevIds = beverages.map((i) => i.id);
  let expiring: any[] = [];
  if (bevIds.length > 0) {
    const { data } = await sb
      .from("restaurant_inventory_batches")
      .select("id, inventory_item_id, batch_number, expiry_date, quantity")
      .eq("tenant_id", input.tenantId)
      .in("inventory_item_id", bevIds)
      .not("expiry_date", "is", null)
      .lte("expiry_date", horizon)
      .gt("quantity", 0)
      .order("expiry_date")
      .limit(20);
    expiring = (data ?? []) as any[];
  }
  const itemName = new Map(beverages.map((i) => [i.id, i.name]));

  /* Today's bar sales — existing POS order items routed to bar stations. */
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  let saleRows: any[] = [];
  if (stationIds.length > 0) {
    const { data } = await sb
      .from("restaurant_order_items")
      .select("quantity, line_total, theoretical_cost, line_cost, currency, status, is_comp")
      .eq("tenant_id", input.tenantId)
      .in("station_id", stationIds)
      .gte("created_at", dayStart.toISOString())
      .limit(2000);
    saleRows = (data ?? []) as any[];
  }
  let net = 0;
  let quantity = 0;
  let cost = 0;
  let compCount = 0;
  let compValue = 0;
  let voidCount = 0;
  let currency = beverages[0]?.currency ?? "TZS";
  for (const r of saleRows) {
    currency = r.currency ?? currency;
    if (r.status === "voided" || r.status === "void") {
      voidCount += 1;
      continue;
    }
    const lineCost = Number(r.theoretical_cost ?? r.line_cost ?? 0);
    cost += lineCost;
    quantity += Number(r.quantity ?? 0);
    if (r.is_comp) {
      compCount += 1;
      compValue += Number(r.line_total ?? 0);
      continue;
    }
    net += Number(r.line_total ?? 0);
  }

  return {
    locations: scope.locations,
    stations: scope.stations,
    tickets: tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticket_number ?? null,
      stationId: t.station_id ?? null,
      stationName: stationName.get(t.station_id) ?? "Bar",
      status: t.status,
      queuedAt: t.queued_at ?? null,
      startedAt: t.started_at ?? null,
      readyAt: t.ready_at ?? null,
      isDelayed: Boolean(t.is_delayed),
      targetMinutes: t.target_minutes ?? null,
      waitingSeconds: t.queued_at ? Math.max(0, Math.round((now - new Date(t.queued_at).getTime()) / 1000)) : 0,
      notes: t.notes ?? null,
    })),
    openTicketCount: tickets.length,
    delayedTicketCount: tickets.filter((t) => t.is_delayed).length,
    pendingRequisitions: ((reqs ?? []) as any[]).map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      createdAt: r.created_at,
    })),
    openTransfers: transfers.map((t) => ({
      id: t.id,
      transferNumber: t.transfer_number,
      status: t.status,
      createdAt: t.created_at,
    })),
    lowStock,
    expiring: expiring.map((b) => ({
      batchId: b.id,
      itemName: itemName.get(b.inventory_item_id) ?? "Stock item",
      batchNumber: b.batch_number ?? null,
      expiryDate: b.expiry_date,
      quantity: Number(b.quantity ?? 0),
    })),
    sales: {
      currency,
      net: round6(net),
      quantity: round6(quantity),
      theoreticalCost: round6(cost),
      grossProfit: round6(net - cost),
      costPercent: net > 0 ? round6((cost / net) * 100) : null,
      compCount,
      compValue: round6(compValue),
      voidCount,
    },
  };
}

/* ---------------- Pour configuration ---------------- */

export async function listBeverages(sb: Sb, userId: string, input: ListBeveragesInput): Promise<BarBeverage[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const units = await unitMap(sb, input.tenantId);

  let q = sb
    .from("restaurant_inventory_items")
    .select(
      "id, name, sku, category_id, unit_id, consumption_unit_id, serving_size, serving_unit_id, is_beverage, item_type, current_quantity, reorder_point, par_level, average_cost, currency",
    )
    .eq("tenant_id", input.tenantId)
    .order("name")
    .limit(input.limit);
  if (!input.includeNonBeverage) q = q.or("is_beverage.eq.true,item_type.eq.beverage");
  if (input.search) q = q.ilike("name", `%${input.search}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  return ((data ?? []) as any[]).map((i) => {
    const stockUnit = i.unit_id ? units.get(i.unit_id) : undefined;
    const servingUnit = i.serving_unit_id ? units.get(i.serving_unit_id) : undefined;
    const maths = pourMaths({
      servingSize: i.serving_size == null ? null : Number(i.serving_size),
      servingUnit,
      stockUnit,
    });
    const onHand = Number(i.current_quantity ?? 0);
    return {
      itemId: i.id,
      name: i.name,
      sku: i.sku ?? null,
      categoryId: i.category_id ?? null,
      onHand,
      reorderPoint: i.reorder_point == null ? null : Number(i.reorder_point),
      parLevel: i.par_level == null ? null : Number(i.par_level),
      averageCost: Number(i.average_cost ?? 0),
      currency: i.currency ?? "TZS",
      stockUnitCode: stockUnit?.code ?? null,
      servingSize: i.serving_size == null ? null : Number(i.serving_size),
      servingUnitId: i.serving_unit_id ?? null,
      servingUnitCode: servingUnit?.code ?? null,
      poursPerStockUnit: maths.poursPerStockUnit,
      stockPerPour: maths.stockPerPour,
      pourCost: computePourCost(Number(i.average_cost ?? 0), maths),
      poursAvailable: poursAvailable(onHand, maths),
      low: i.reorder_point != null && onHand <= Number(i.reorder_point),
      ...(maths.exact ? {} : { pourIssue: maths.reason }),
    } satisfies BarBeverage;
  });
}

export async function savePourConfig(sb: Sb, userId: string, input: SavePourConfigInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const { data, error } = await sb
    .from("restaurant_inventory_items")
    .update({
      is_beverage: input.isBeverage,
      serving_size: input.servingSize,
      serving_unit_id: input.servingUnitId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.inventoryItemId)
    .eq("tenant_id", input.tenantId)
    .select("id, name, serving_size, serving_unit_id, is_beverage")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "bar.pour.configured",
    tenantId: input.tenantId,
    entityType: "restaurant_inventory_item",
    entityId: data.id,
    source: "restaurant-os",
    payload: {
      name: data.name,
      serving_size: data.serving_size == null ? null : Number(data.serving_size),
      serving_unit_id: data.serving_unit_id,
      is_beverage: data.is_beverage,
    },
  });
  return data;
}

/* ---------------- Theoretical vs actual ---------------- */

export async function beverageVariance(
  sb: Sb,
  userId: string,
  input: BeverageVarianceInput,
): Promise<BarVarianceRow[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const units = await unitMap(sb, input.tenantId);
  const to = input.to ?? new Date().toISOString();

  const { data: itemRows } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, unit_id, current_quantity, average_cost, currency")
    .eq("tenant_id", input.tenantId)
    .or("is_beverage.eq.true,item_type.eq.beverage")
    .order("name")
    .limit(input.limit);
  const items = (itemRows ?? []) as any[];
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);

  /* Movements inside the window — the ledger is the only source of truth. */
  let mq = sb
    .from("restaurant_stock_movements")
    .select("inventory_item_id, movement_type, quantity, occurred_at, location_id, destination_location_id")
    .eq("tenant_id", input.tenantId)
    .in("inventory_item_id", ids)
    .gte("occurred_at", input.from)
    .lte("occurred_at", to)
    .order("occurred_at", { ascending: true })
    .limit(5000);
  if (input.locationId) mq = mq.eq("location_id", input.locationId);
  const { data: movements } = await mq;

  /* Opening balance = balance after the last movement before the window. */
  const opening = new Map<string, number>();
  for (const id of ids) {
    let oq = sb
      .from("restaurant_stock_movements")
      .select("balance_after")
      .eq("tenant_id", input.tenantId)
      .eq("inventory_item_id", id)
      .lt("occurred_at", input.from)
      .order("occurred_at", { ascending: false })
      .limit(1);
    if (input.locationId) oq = oq.eq("location_id", input.locationId);
    const { data } = await oq;
    opening.set(id, Number((data ?? [])[0]?.balance_after ?? 0));
  }

  const agg = new Map<string, { received: number; inQty: number; outQty: number; consumption: number; wastage: number; net: number }>();
  for (const id of ids) agg.set(id, { received: 0, inQty: 0, outQty: 0, consumption: 0, wastage: 0, net: 0 });
  for (const m of (movements ?? []) as any[]) {
    const a = agg.get(m.inventory_item_id);
    if (!a) continue;
    const q = Number(m.quantity ?? 0);
    a.net += q;
    switch (m.movement_type) {
      case "purchase_receipt":
        a.received += Math.abs(q);
        break;
      case "transfer_in":
        a.inQty += Math.abs(q);
        break;
      case "transfer_out":
        a.outQty += Math.abs(q);
        break;
      case "consumption":
        a.consumption += Math.abs(q);
        break;
      case "wastage":
        a.wastage += Math.abs(q);
        break;
      default:
        break;
    }
  }

  /* Actual = the most recent counted quantity from a posted stocktake in the window. */
  const counted = new Map<string, number>();
  const { data: stocktakes } = await sb
    .from("restaurant_stocktakes")
    .select("id, posted_at, location_id, status")
    .eq("tenant_id", input.tenantId)
    .gte("posted_at", input.from)
    .lte("posted_at", to)
    .order("posted_at", { ascending: true })
    .limit(50);
  const takeIds = ((stocktakes ?? []) as any[])
    .filter((s) => !input.locationId || s.location_id === input.locationId)
    .map((s) => s.id);
  if (takeIds.length > 0) {
    const { data: lines } = await sb
      .from("restaurant_stocktake_lines")
      .select("inventory_item_id, counted_quantity, stocktake_id")
      .in("stocktake_id", takeIds)
      .in("inventory_item_id", ids);
    for (const l of (lines ?? []) as any[]) {
      if (l.counted_quantity == null) continue;
      counted.set(l.inventory_item_id, Number(l.counted_quantity));
    }
  }

  return items.map((i) => {
    const a = agg.get(i.id)!;
    const open = opening.get(i.id) ?? 0;
    const expected = round6(open + a.net);
    const hasCount = counted.has(i.id);
    const actual = hasCount ? Number(counted.get(i.id)) : Number(i.current_quantity ?? 0);
    const variance = round6(actual - expected);
    const cost = Number(i.average_cost ?? 0);
    return {
      itemId: i.id,
      name: i.name,
      unitCode: i.unit_id ? (units.get(i.unit_id)?.code ?? null) : null,
      opening: round6(open),
      received: round6(a.received),
      transferredIn: round6(a.inQty),
      transferredOut: round6(a.outQty),
      theoreticalConsumption: round6(a.consumption),
      wastage: round6(a.wastage),
      expectedClosing: expected,
      actualClosing: actual,
      actualSource: hasCount ? "stocktake" : "ledger",
      variance,
      variancePercent: expected !== 0 ? round6((variance / Math.abs(expected)) * 100) : null,
      varianceValue: round6(variance * cost),
      currency: i.currency ?? "TZS",
    } satisfies BarVarianceRow;
  });
}

/** Records the investigation of a variance as a fact for the Intelligence Core. */
export async function flagBeverageVariance(sb: Sb, userId: string, input: FlagVarianceInput) {
  await assertCapability(sb, userId, input.tenantId, "variance.manage");
  const { data: item } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, average_cost, currency")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.inventoryItemId)
    .single();
  if (!item) throw new Error("Stock item not found in this tenant.");

  const variance = round6(input.actual - input.expected);
  const res = await emitRestaurantEvent(sb, userId, {
    type: "bar.beverage.variance.detected",
    tenantId: input.tenantId,
    locationId: input.locationId,
    entityType: "restaurant_inventory_item",
    entityId: item.id,
    source: "restaurant-os",
    payload: {
      name: item.name,
      expected: input.expected,
      actual: input.actual,
      variance,
      variance_value: round6(variance * Number(item.average_cost ?? 0)),
      currency: item.currency ?? "TZS",
      reason_code: input.reasonCode,
      notes: input.notes ?? null,
    },
  });
  return { flagged: true, observed: res.delivered, variance };
}

/* ---------------- Complimentary drinks ---------------- */

export async function compOrderItem(sb: Sb, userId: string, input: CompDrinkInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.discount");
  const { data: existing } = await sb
    .from("restaurant_order_items")
    .select("id, order_id, description, line_total, currency, status, is_comp")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderItemId)
    .single();
  if (!existing) throw new Error("Order line not found in this tenant.");
  if (existing.status === "voided" || existing.status === "void") {
    throw new Error("A voided line cannot be comped — void, comp and refund are different events.");
  }
  if (Boolean(existing.is_comp) === input.comp) {
    return { id: existing.id, isComp: Boolean(existing.is_comp), unchanged: true };
  }

  const { data, error } = await sb
    .from("restaurant_order_items")
    .update({
      is_comp: input.comp,
      comp_reason: input.comp ? input.reason : null,
      comp_by: input.comp ? userId : null,
      comp_at: input.comp ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.orderItemId)
    .eq("tenant_id", input.tenantId)
    .select("id, order_id, description, line_total, currency, is_comp")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "bar.drink.comped",
    tenantId: input.tenantId,
    entityType: "restaurant_order_item",
    entityId: data.id,
    source: "restaurant-os",
    payload: {
      order_id: data.order_id,
      description: data.description,
      value: Number(data.line_total ?? 0),
      currency: data.currency ?? "TZS",
      comp: input.comp,
      reason: input.reason,
    },
  });
  // The drink was made: stock consumption stands. A comp is a revenue event,
  // never a stock reversal.
  return { id: data.id, isComp: Boolean(data.is_comp), unchanged: false };
}