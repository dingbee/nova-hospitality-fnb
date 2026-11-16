/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Stock positions — item × location.
 *
 * Every quantity here is *derived*: on hand comes from the ledger view,
 * reserved from active reservations, incoming from open procurement.
 * Nothing in this file writes a balance.
 */
import { assertTenantRead } from "../core/access.server";
import { locationNameMap } from "./locations.server";
import type { LocationPosition, StockPosition, StockPositionsInput } from "./contracts";
import { stockUnitsPerUnit, type InboundCommitment } from "./stock-position.contract";

type Sb = any;

const OPEN_PO_STATUSES = ["submitted", "approved", "partially_received"];

/** Active reservations grouped by item and by item+location. */
async function reservationIndex(sb: Sb, tenantId: string) {
  const { data } = await sb
    .from("restaurant_stock_reservations")
    .select("inventory_item_id, location_id, quantity")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  const byItem = new Map<string, number>();
  const byItemLocation = new Map<string, number>();
  for (const r of (data ?? []) as any[]) {
    const q = Number(r.quantity ?? 0);
    byItem.set(r.inventory_item_id, (byItem.get(r.inventory_item_id) ?? 0) + q);
    const key = `${r.inventory_item_id}:${r.location_id ?? "none"}`;
    byItemLocation.set(key, (byItemLocation.get(key) ?? 0) + q);
  }
  return { byItem, byItemLocation };
}

/** Quantity expected from open purchase orders (ordered minus received). */
export async function incomingIndex(sb: Sb, tenantId: string): Promise<Map<string, number>> {
  const { data: orders } = await sb
    .from("restaurant_purchase_orders")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .in("status", OPEN_PO_STATUSES);
  const ids = ((orders ?? []) as any[]).map((o) => o.id);
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const { data: lines } = await sb
    .from("restaurant_purchase_order_items")
    .select("inventory_item_id, quantity, received_quantity")
    .in("purchase_order_id", ids);
  for (const l of (lines ?? []) as any[]) {
    if (!l.inventory_item_id) continue;
    const outstanding = Number(l.quantity ?? 0) - Number(l.received_quantity ?? 0);
    if (outstanding <= 0) continue;
    map.set(l.inventory_item_id, (map.get(l.inventory_item_id) ?? 0) + outstanding);
  }
  return map;
}

export async function listStockPositions(
  sb: Sb,
  userId: string,
  input: StockPositionsInput,
): Promise<StockPosition[]> {
  await assertTenantRead(sb, userId, input.tenantId);

  let itemQuery = sb
    .from("restaurant_inventory_items")
    .select(
      "id, name, sku, category_id, unit_id, currency, average_cost, current_quantity, reorder_point, par_level, track_batches, allow_negative, status",
    )
    .eq("tenant_id", input.tenantId)
    .order("name")
    .limit(input.limit);
  if (input.propertyId) itemQuery = itemQuery.eq("property_id", input.propertyId);
  if (input.categoryId) itemQuery = itemQuery.eq("category_id", input.categoryId);
  if (input.itemId) itemQuery = itemQuery.eq("id", input.itemId);
  if (input.search) itemQuery = itemQuery.ilike("name", `%${input.search}%`);

  const [{ data: items, error }, { data: ledger }, reservations, incoming, locations] = await Promise.all([
    itemQuery,
    sb
      .from("restaurant_stock_positions_v")
      .select("inventory_item_id, location_id, on_hand, last_movement_at")
      .eq("tenant_id", input.tenantId),
    reservationIndex(sb, input.tenantId),
    incomingIndex(sb, input.tenantId),
    locationNameMap(sb, input.tenantId),
  ]);
  if (error) throw new Error(error.message);

  const byItem = new Map<string, any[]>();
  for (const row of (ledger ?? []) as any[]) {
    if (input.locationId && row.location_id !== input.locationId) continue;
    if (!byItem.has(row.inventory_item_id)) byItem.set(row.inventory_item_id, []);
    byItem.get(row.inventory_item_id)!.push(row);
  }

  const positions = ((items ?? []) as any[]).map((item) => {
    const rows = byItem.get(item.id) ?? [];
    const locationPositions: LocationPosition[] = rows
      .map((r) => {
        const onHand = Number(r.on_hand ?? 0);
        const reserved = reservations.byItemLocation.get(`${item.id}:${r.location_id ?? "none"}`) ?? 0;
        return {
          locationId: r.location_id ?? null,
          locationName: r.location_id ? (locations.get(r.location_id) ?? "Unknown location") : "Unassigned",
          onHand,
          reserved,
          available: onHand - reserved,
          lastMovementAt: r.last_movement_at ?? null,
        };
      })
      .sort((a, b) => b.onHand - a.onHand);

    // When a location filter is applied the position is that location's slice;
    // otherwise the ledger total, which must agree with the item balance.
    const onHand = input.locationId
      ? locationPositions.reduce((s, l) => s + l.onHand, 0)
      : Number(item.current_quantity ?? 0);
    const reserved = input.locationId
      ? locationPositions.reduce((s, l) => s + l.reserved, 0)
      : (reservations.byItem.get(item.id) ?? 0);
    const averageCost = Number(item.average_cost ?? 0);
    const reorderPoint = item.reorder_point == null ? null : Number(item.reorder_point);
    const available = onHand - reserved;

    return {
      itemId: item.id,
      name: item.name,
      sku: item.sku ?? null,
      categoryId: item.category_id ?? null,
      unitId: item.unit_id ?? null,
      currency: item.currency ?? "TZS",
      averageCost,
      onHand,
      reserved,
      available,
      incoming: incoming.get(item.id) ?? 0,
      value: Number((onHand * averageCost).toFixed(2)),
      reorderPoint,
      parLevel: item.par_level == null ? null : Number(item.par_level),
      low: reorderPoint != null && available <= reorderPoint,
      critical: available <= 0 || (reorderPoint != null && available <= reorderPoint / 2),
      trackBatches: Boolean(item.track_batches),
      allowNegative: Boolean(item.allow_negative),
      lastMovementAt:
        locationPositions.map((l) => l.lastMovementAt).filter(Boolean).sort().slice(-1)[0] ?? null,
      locations: locationPositions,
    } satisfies StockPosition;
  });

  return input.lowOnly ? positions.filter((p) => p.low) : positions;
}



function replenishmentDeliveryTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + "T23:59:59.999Z";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export interface ReplenishmentPositionEvidence {
  itemId: string;
  onHand: number;
  reservations: Array<{ id: string; quantity: number; status: string; expiresAt: string | null }>;
  inbound: InboundCommitment[];
  receivingRecords: Array<{ purchaseOrderItemId: string; ordered: number; received: number; accepted: number; rejectedOrDamaged: number }>;
  lastMovementAt: string | null;
  ledgerLocations: Array<{ locationId: string | null; movementCount: number; lastMovementAt: string | null }>;
  manualReviewReasons: string[];
}

/**
 * Replenishment evidence adapter over the existing inventory/procurement
 * ledgers. It is read-only and deliberately fails closed on source-query
 * errors. Tenant central-store stock is not silently pooled into a property:
 * only locations owned by the requested property are counted. A transfer
 * dispatched from a central store becomes destination inbound only.
 */
export async function getStockPositionEvidenceForReplenishment(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    itemIds: string[];
    items: Array<{
      id: string;
      property_id?: string | null;
      unit_id?: string | null;
      purchase_unit_id?: string | null;
      pack_size?: number | null;
      current_quantity?: number | null;
    }>;
    propertyId?: string | null;
    locationId?: string | null;
    asOf: string;
  },
): Promise<Map<string, ReplenishmentPositionEvidence>> {
  if (!input.propertyId && !input.locationId) {
    throw new Error("Stock-position evidence requires an explicit property or stock-location scope.");
  }
  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  if (input.itemIds.length === 0) return new Map();
  const asOfTime = Date.parse(input.asOf);
  if (!Number.isFinite(asOfTime)) throw new Error("Invalid replenishment evidence timestamp.");

  const [locationsRes, ledgerRes, reservationsRes, ordersRes, transfersRes, unitsRes] =
    await Promise.all([
      sb.from("restaurant_locations")
        .select("id, property_id, scope, is_storage, status")
        .eq("tenant_id", input.tenantId),
      sb.from("restaurant_stock_positions_v")
        .select("inventory_item_id, location_id, on_hand, last_movement_at, movement_count")
        .eq("tenant_id", input.tenantId)
        .in("inventory_item_id", input.itemIds),
      sb.from("restaurant_stock_reservations")
        .select("id, inventory_item_id, property_id, location_id, unit_id, quantity, status, expires_at")
        .eq("tenant_id", input.tenantId)
        .eq("status", "active")
        .in("inventory_item_id", input.itemIds),
      (() => {
        let q = sb.from("restaurant_purchase_orders")
          .select("id, supplier_id, status, expected_at, property_id, location_id, currency")
          .eq("tenant_id", input.tenantId)
          .in("status", OPEN_PO_STATUSES);
        if (input.locationId) q = q.eq("location_id", input.locationId);
        return q;
      })(),
      (() => {
        let q = sb.from("restaurant_stock_transfers")
          .select("id, property_id, source_location_id, destination_location_id, status, dispatched_at")
          .eq("tenant_id", input.tenantId)
          .in("status", ["dispatched", "partially_received"]);
        if (input.locationId) q = q.eq("destination_location_id", input.locationId);
        return q;
      })(),
      sb.from("restaurant_inventory_units")
        .select("id, dimension, base_unit_id, factor")
        .or("tenant_id.eq." + input.tenantId + ",tenant_id.is.null"),
    ]);

  for (const [label, result] of [
    ["inventory locations", locationsRes],
    ["stock ledger positions", ledgerRes],
    ["stock reservations", reservationsRes],
    ["open purchase orders", ordersRes],
    ["in-transit transfers", transfersRes],
    ["inventory units", unitsRes],
  ] as const) {
    if (result.error) throw new Error("Unable to load " + label + " for replenishment: " + result.error.message);
  }

  const locationRows = (locationsRes.data ?? []) as any[];
  const locationById = new Map(locationRows.map((row) => [row.id, row]));
  const allowedLocationIds = new Set<string>(
    input.locationId
      ? [input.locationId]
      : input.propertyId
        ? locationRows.filter((row) => row.property_id === input.propertyId && row.is_storage === true).map((row) => row.id)
        : locationRows.filter((row) => row.is_storage === true).map((row) => row.id),
  );
  if (input.locationId && !locationById.has(input.locationId)) {
    throw new Error("Requested stock location does not belong to this tenant.");
  }
  if (input.locationId && locationById.get(input.locationId)?.is_storage !== true) {
    throw new Error("Requested stock location is not configured as an inventory storage location.");
  }
  if (input.locationId && locationById.get(input.locationId)?.status !== "active") {
    throw new Error("Requested stock location is inactive and cannot receive replenishment.");
  }
  if (input.locationId && input.propertyId &&
      locationById.get(input.locationId)?.property_id !== input.propertyId) {
    throw new Error("Requested stock location does not belong to the selected property.");
  }
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const units = (unitsRes.data ?? []) as Array<{ id: string; dimension: string; base_unit_id: string | null; factor: number }>;
  const result = new Map<string, ReplenishmentPositionEvidence>();
  for (const itemId of input.itemIds) {
    result.set(itemId, {
      itemId,
      onHand: 0,
      reservations: [],
      inbound: [],
      receivingRecords: [],
      lastMovementAt: null,
      ledgerLocations: [],
      manualReviewReasons: [],
    });
  }

  for (const row of (ledgerRes.data ?? []) as any[]) {
    const locationId = row.location_id ?? null;
    const location = locationId ? locationById.get(locationId) : null;
    const inScope = input.locationId
      ? locationId === input.locationId
      : input.propertyId
        ? location?.property_id === input.propertyId && location?.is_storage === true
        : locationId === null || allowedLocationIds.has(locationId);
    if (!inScope) continue;
    const evidence = result.get(row.inventory_item_id);
    if (!evidence) continue;
    const quantity = Number(row.on_hand ?? 0);
    const movementCount = Number(row.movement_count ?? 0);
    if (!Number.isFinite(quantity) || !Number.isFinite(movementCount)) {
      evidence.manualReviewReasons.push("Stock ledger contains invalid aggregate quantities.");
      continue;
    }
    evidence.onHand += quantity;
    evidence.ledgerLocations.push({
      locationId,
      movementCount,
      lastMovementAt: row.last_movement_at ?? null,
    });
    if (row.last_movement_at && (!evidence.lastMovementAt || row.last_movement_at > evidence.lastMovementAt)) {
      evidence.lastMovementAt = row.last_movement_at;
    }
  }

  for (const row of (reservationsRes.data ?? []) as any[]) {
    const evidence = result.get(row.inventory_item_id);
    const locationId = row.location_id ?? null;
    const location = locationId ? locationById.get(locationId) : null;
    const inScope = input.locationId
      ? locationId === input.locationId
      : input.propertyId
        ? (row.property_id === input.propertyId && (!locationId || (location?.property_id === input.propertyId && location?.is_storage === true))) ||
          (location?.property_id === input.propertyId && location?.is_storage === true)
        : locationId === null || allowedLocationIds.has(locationId);
    if (!evidence || !inScope) continue;
    const factor = stockUnitsPerUnit(row.unit_id, itemById.get(row.inventory_item_id)?.unit_id ?? null,
      itemById.get(row.inventory_item_id)?.purchase_unit_id ?? null,
      itemById.get(row.inventory_item_id)?.pack_size ?? null, units);
    if (factor == null) {
      evidence.manualReviewReasons.push("Reservation " + row.id + " has an unconvertible unit.");
      continue;
    }
    const expiresAt = row.expires_at ?? null;
    if (expiresAt && Date.parse(expiresAt) <= asOfTime) continue;
    evidence.reservations.push({
      id: row.id,
      quantity: Number(row.quantity) * factor,
      status: row.status,
      expiresAt,
    });
  }

  const orders = ((ordersRes.data ?? []) as any[]).filter((order) => {
    if (input.locationId) return order.location_id === input.locationId;
    if (input.propertyId) {
      const locationProperty = order.location_id ? locationById.get(order.location_id)?.property_id : null;
      if (order.property_id === input.propertyId) return !order.location_id || locationProperty === input.propertyId;
      return !order.property_id && locationProperty === input.propertyId;
    }
    return true;
  });
  const orderIds = orders.map((row) => row.id);
  const transfers = ((transfersRes.data ?? []) as any[]).filter((transfer) => {
    if (input.locationId) return transfer.destination_location_id === input.locationId;
    if (input.propertyId) return locationById.get(transfer.destination_location_id)?.property_id === input.propertyId;
    return true;
  });
  const transferIds = transfers.map((row) => row.id);
  const [poLinesRes, confirmationsRes, transferLinesRes] = await Promise.all([
    orderIds.length
      ? sb.from("restaurant_purchase_order_items")
          .select("id, purchase_order_id, inventory_item_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, quantity, received_quantity, accepted_quantity, rejected_quantity")
          .eq("tenant_id", input.tenantId)
          .in("purchase_order_id", orderIds)
          .in("inventory_item_id", input.itemIds)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? sb.from("restaurant_supplier_confirmations")
          .select("id, purchase_order_id, status, confirmed_delivery_date, created_at")
          .eq("tenant_id", input.tenantId)
          .in("purchase_order_id", orderIds)
          
      : Promise.resolve({ data: [], error: null }),
    transferIds.length
      ? sb.from("restaurant_stock_transfer_lines")
          .select("id, transfer_id, inventory_item_id, unit_id, dispatched_quantity, received_quantity, rejected_quantity, damaged_quantity")
          .eq("tenant_id", input.tenantId)
          .in("transfer_id", transferIds)
          .in("inventory_item_id", input.itemIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [label, query] of [
    ["purchase-order lines", poLinesRes],
    ["supplier delivery confirmations", confirmationsRes],
    ["stock-transfer lines", transferLinesRes],
  ] as const) {
    if (query.error) throw new Error("Unable to load " + label + " for replenishment: " + query.error.message);
  }

  const confirmationRows = (confirmationsRes.data ?? []) as any[];
  const confirmationIds = confirmationRows.map((row) => row.id);
  const confirmationItemsRes = confirmationIds.length
    ? await sb.from("restaurant_supplier_confirmation_items")
        .select("confirmation_id, purchase_order_item_id, confirmed_quantity, confirmed_delivery_date")
        .eq("tenant_id", input.tenantId)
        .in("confirmation_id", confirmationIds)
    : { data: [], error: null };
  if (confirmationItemsRes.error) {
    throw new Error("Unable to load confirmed supplier quantities: " + confirmationItemsRes.error.message);
  }
  const confirmationByLine = new Map<string, any>();
  for (const row of (confirmationItemsRes.data ?? []) as any[]) {
    const header = confirmationRows.find((candidate) => candidate.id === row.confirmation_id);
    if (!header || ["pending", "draft"].includes(header.status)) continue;
    const previous = confirmationByLine.get(row.purchase_order_item_id);
    if (!previous || String(header.created_at ?? "") > String(previous.header.created_at ?? "")) {
      confirmationByLine.set(row.purchase_order_item_id, { row, header });
    }
  }
  const orderById = new Map(orders.map((row) => [row.id, row]));
  for (const line of (poLinesRes.data ?? []) as any[]) {
    const evidence = result.get(line.inventory_item_id);
    const order = orderById.get(line.purchase_order_id);
    const item = itemById.get(line.inventory_item_id);
    if (!evidence || !order || !item) continue;
    const orderLocation = order.location_id ? locationById.get(order.location_id) : null;
    if (!orderLocation || orderLocation.is_storage !== true || orderLocation.status !== "active") {
      evidence.manualReviewReasons.push("Purchase order " + order.id + " has no active inventory delivery location.");
      continue;
    }
    const quantity = Number(line.quantity);
    const received = Number(line.received_quantity);
    const accepted = Number(line.accepted_quantity);
    const rejectedOrDamaged = Number(line.rejected_quantity ?? 0);
    if (!Number.isFinite(quantity) || !Number.isFinite(received) || !Number.isFinite(accepted) ||
        !Number.isFinite(rejectedOrDamaged) || quantity < 0 || received < 0 || accepted < 0 ||
        rejectedOrDamaged < 0 || received > quantity + 1e-8 ||
        accepted + rejectedOrDamaged > received + 1e-8) {
      evidence.manualReviewReasons.push("Purchase-order line " + line.id + " has invalid ordered/received/accepted/rejected quantities.");
      continue;
    }
    evidence.receivingRecords.push({
      purchaseOrderItemId: line.id,
      ordered: quantity,
      received,
      accepted,
      rejectedOrDamaged,
    });
    if (rejectedOrDamaged > 0) {
      evidence.manualReviewReasons.push("PO line " + line.id + " has rejected or damaged receipts requiring supplier reconciliation.");
    }
    // All received goods (accepted, rejected or damaged) are no longer an
    // outstanding delivery. Only accepted goods have already entered on-hand;
    // rejected/damaged goods remain excluded until a replacement is confirmed.
    const outstanding = Math.max(0, quantity - received);
    if (outstanding <= 0) continue;
    let factor: number | null = null;
    if (line.stock_units_per_purchase_unit != null) {
      const snapshotFactor = Number(line.stock_units_per_purchase_unit);
      if (!line.stock_unit_id || line.stock_unit_id !== item.unit_id || !Number.isFinite(snapshotFactor) || snapshotFactor <= 0) {
        evidence.manualReviewReasons.push("Purchase-order line " + line.id + " has a missing, invalid or obsolete stock-unit snapshot.");
        continue;
      }
      factor = snapshotFactor;
    } else if (line.unit_id === item.unit_id) {
      // Legacy POs ordered directly in the current stock unit are unambiguous.
      factor = 1;
    } else {
      evidence.manualReviewReasons.push("Legacy purchase-order line " + line.id + " has no immutable purchase-to-stock conversion snapshot.");
      continue;
    }
    const confirmation = confirmationByLine.get(line.id);
    const confirmationStatus = confirmation?.header.status ?? null;
    if (confirmation && ["declined", "rejected", "cancelled"].includes(confirmationStatus)) {
      evidence.manualReviewReasons.push("Supplier declined or cancelled confirmation for PO line " + line.id + ".");
      continue;
    }
    if (confirmation && !["confirmed", "partially_confirmed"].includes(confirmationStatus)) {
      evidence.manualReviewReasons.push("Supplier confirmation for PO line " + line.id + " has an unsupported status.");
      continue;
    }
    const isConfirmed = Boolean(confirmation && ["confirmed", "partially_confirmed"].includes(confirmationStatus));
    const confirmedTotal = isConfirmed ? Number(confirmation.row.confirmed_quantity ?? 0) : null;
    if (confirmedTotal != null && (!Number.isFinite(confirmedTotal) || confirmedTotal < 0 || confirmedTotal > quantity + 1e-8)) {
      evidence.manualReviewReasons.push("Supplier confirmation for PO line " + line.id + " has an invalid confirmed total.");
      continue;
    }
    if (isConfirmed) {
      // Supplier confirmations store the total agreed line quantity, not the
      // remaining balance. Subtract all received goods (accepted/rejected/
      // damaged) exactly once; only the confirmed remainder is eligible.
      const confirmedRemaining = Math.min(outstanding, Math.max(0, Number(confirmedTotal) - received));
      const confirmedDate = confirmation.row.confirmed_delivery_date ?? confirmation.header.confirmed_delivery_date ?? order.expected_at ?? null;
      const confirmedExpectedAt = replenishmentDeliveryTimestamp(confirmedDate);
      if (confirmedRemaining > 0) {
        if (!confirmedExpectedAt) evidence.manualReviewReasons.push("Supplier confirmation for PO line " + line.id + " has no valid delivery date.");
        evidence.inbound.push({
          sourceId: confirmation.header.id,
          sourceType: "supplier_confirmation",
          quantityInStockUnits: confirmedRemaining * factor,
          expectedAt: confirmedExpectedAt,
          status: confirmation.header.status,
        });
      }
      if (confirmedRemaining + 1e-8 < outstanding) {
        evidence.manualReviewReasons.push("Supplier has not confirmed the full outstanding quantity for PO line " + line.id + ".");
      }
    } else if (outstanding > 0) {
      const expectedAt = replenishmentDeliveryTimestamp(order.expected_at);
      if (!expectedAt) evidence.manualReviewReasons.push("Outstanding PO line " + line.id + " has no valid expected delivery date.");
      evidence.inbound.push({
        sourceId: order.id + ":" + line.id,
        sourceType: "purchase_order",
        quantityInStockUnits: outstanding * factor,
        expectedAt,
        status: order.status,
      });
    }
  }

  const transferById = new Map(transfers.map((row) => [row.id, row]));
  for (const line of (transferLinesRes.data ?? []) as any[]) {
    const evidence = result.get(line.inventory_item_id);
    const transfer = transferById.get(line.transfer_id);
    const item = itemById.get(line.inventory_item_id);
    if (!evidence || !transfer || !item) continue;
    const destinationLocation = locationById.get(transfer.destination_location_id);
    if (!destinationLocation || destinationLocation.is_storage !== true || destinationLocation.status !== "active") {
      evidence.manualReviewReasons.push("In-transit transfer " + transfer.id + " has no active destination storage location.");
      continue;
    }
    const dispatched = Number(line.dispatched_quantity ?? 0);
    const received = Number(line.received_quantity ?? 0);
    const rejected = Number(line.rejected_quantity ?? 0);
    const damaged = Number(line.damaged_quantity ?? 0);
    if ([dispatched, received, rejected, damaged].some((value) => !Number.isFinite(value) || value < 0) ||
        received + rejected + damaged > dispatched + 1e-8) {
      evidence.manualReviewReasons.push("Transfer line " + line.id + " has invalid dispatched/received quantities.");
      continue;
    }
    if (rejected > 0 || damaged > 0) {
      evidence.manualReviewReasons.push("Transfer line " + line.id + " has rejected or damaged quantities requiring reconciliation.");
    }
    const outstanding = Math.max(0, dispatched - received - rejected - damaged);
    if (outstanding <= 0) continue;
    const factor = stockUnitsPerUnit(line.unit_id, item.unit_id ?? null, item.purchase_unit_id ?? null, item.pack_size ?? null, units);
    if (factor == null) {
      evidence.manualReviewReasons.push("Transfer line " + line.id + " has an unconvertible unit.");
      continue;
    }
    // The transfer schema has no arrival-ETA field. Preserve the in-transit
    // quantity as evidence, but do not count it as available until an ETA is
    // recorded; this forces an explicit manual review rather than guessing.
    evidence.inbound.push({
      sourceId: transfer.id + ":" + line.id,
      sourceType: "stock_transfer",
      quantityInStockUnits: outstanding * factor,
      expectedAt: null,
      status: transfer.status,
    });
    evidence.manualReviewReasons.push("Dispatched transfer " + transfer.id + " has no expected-arrival date; quantity is excluded from available stock.");
  }

  for (const [itemId, evidence] of result) {
    const item = itemById.get(itemId);
    if (!input.locationId && item?.current_quantity != null &&
        (!input.propertyId || item.property_id === input.propertyId)) {
      const current = Number(item.current_quantity);
      if (Number.isFinite(current) && Math.abs(current - evidence.onHand) > 0.0001) {
        evidence.manualReviewReasons.push("Inventory item balance differs from the stock-ledger aggregate.");
      }
    }
    evidence.manualReviewReasons = [...new Set(evidence.manualReviewReasons)].sort();
  }
  return result;
}

/** Everything an inventory manager needs about one item, on one screen. */
export async function getItemDetail(sb: Sb, userId: string, tenantId: string, itemId: string) {
  await assertTenantRead(sb, userId, tenantId);

  const [positions, movements, batches, reservations, recipes, supplierPrices, openOrders] =
    await Promise.all([
      listStockPositions(sb, userId, {
        tenantId,
        itemId,
        lowOnly: false,
        limit: 1,
      } as StockPositionsInput),
      sb
        .from("restaurant_stock_movements")
        .select(
          "id, movement_type, quantity, unit_cost, total_cost, balance_after, location_id, destination_location_id, reason, reason_code, notes, occurred_at, reference_type, reference_id, transfer_id, stocktake_id, reversal_of_id",
        )
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("occurred_at", { ascending: false })
        .limit(120),
      sb
        .from("restaurant_inventory_batches")
        .select("id, batch_number, expiry_date, received_date, quantity, unit_cost, status, location_id, supplier_id")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("expiry_date", { ascending: true, nullsFirst: false })
        .limit(50),
      sb
        .from("restaurant_stock_reservations")
        .select("id, quantity, purpose, status, location_id, needed_at, reference_type, reference_id")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .eq("status", "active"),
      sb
        .from("restaurant_recipe_components")
        .select("id, menu_item_id, quantity, yield_percent")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId),
      sb
        .from("restaurant_supplier_price_history")
        .select("id, supplier_id, unit_price, currency, recorded_at, stage")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("recorded_at", { ascending: false })
        .limit(30),
      sb
        .from("restaurant_purchase_order_items")
        .select("id, purchase_order_id, quantity, received_quantity, unit_price, description")
        .eq("inventory_item_id", itemId)
        .limit(50),
    ]);

  const locations = await locationNameMap(sb, tenantId);
  const decorate = (rows: any[] | null | undefined) =>
    ((rows ?? []) as any[]).map((r) => ({
      ...r,
      location_name: r.location_id ? (locations.get(r.location_id) ?? "Unknown") : "Unassigned",
    }));

  const moves = decorate(movements.data);
  return {
    position: positions[0] ?? null,
    movements: moves,
    consumption: moves.filter((m) => m.movement_type === "consumption"),
    waste: moves.filter((m) => m.movement_type === "wastage"),
    transfers: moves.filter((m) => m.movement_type === "transfer_in" || m.movement_type === "transfer_out"),
    receipts: moves.filter((m) => m.movement_type === "purchase_receipt"),
    stocktakes: moves.filter((m) => m.stocktake_id),
    batches: decorate(batches.data),
    reservations: decorate(reservations.data),
    recipeUsage: (recipes.data ?? []) as any[],
    supplierPricing: (supplierPrices.data ?? []) as any[],
    openOrderLines: ((openOrders.data ?? []) as any[]).filter(
      (l) => Number(l.quantity ?? 0) - Number(l.received_quantity ?? 0) > 0,
    ),
  };
}