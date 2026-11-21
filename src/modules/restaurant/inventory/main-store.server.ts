/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Main Store Management — the operational read model of the tenant central
 * store.
 *
 * This is NOT a second inventory system. Every number here is read from the
 * canonical records the rest of LexiBite already writes: the stock ledger
 * (`restaurant_stock_movements` / `restaurant_stock_positions_v`), purchase
 * orders, goods receipts, stock transfers and procurement variances. Actions
 * taken from the workspace call the existing governed services (receiving,
 * transfer dispatch/receipt/close, PO transitions) — nothing here mutates.
 */
import { assertTenantRead } from "../core/access.server";
import { getCentralStoreStatus, type CentralStoreStatus } from "./central-store.server";
import { listStockPositions } from "./positions.server";
import { locationNameMap } from "./locations.server";

type Sb = any;

const OPEN_PO = ["submitted", "approved", "partially_received"];
const IN_TRANSIT = ["dispatched", "partially_received"];
const OPEN_TRANSFER = ["draft", "requested", "approved", ...IN_TRANSIT];

const num = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export interface MainStoreException {
  kind:
    | "unassigned_purchase_order"
    | "inactive_supplier_on_open_order"
    | "unpriced_order_line"
    | "transfer_in_transit"
    | "open_variance"
    | "receipt_ledger_mismatch";
  severity: "high" | "medium" | "low";
  reference: string;
  message: string;
  entityId: string | null;
}

async function userNames(sb: Sb, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  // Best effort: display names are presentation only, never authorization.
  const { data, error } = await sb
    .from("app_users")
    .select("user_id, full_name, email")
    .in("user_id", unique);
  if (!error) {
    for (const u of (data ?? []) as any[]) {
      names.set(u.user_id, u.full_name || u.email || u.user_id);
    }
  }
  return names;
}

export async function getMainStoreOverview(sb: Sb, userId: string, tenantId: string) {
  const status: CentralStoreStatus = await getCentralStoreStatus(sb, tenantId);
  if (!status.active || !status.locationId) {
    return { status, active: false as const };
  }
  const storeId = status.locationId;
  // The central store is tenant-scoped: canAccessLocation admits only an
  // explicit tenant-wide grant. A property-only member is refused here.
  await assertTenantRead(sb, userId, tenantId, { locationId: storeId });

  const [
    positions,
    locations,
    { data: orders, error: ordersError },
    { data: receipts, error: receiptsError },
    { data: transfersOut, error: outError },
    { data: transfersIn, error: inError },
    { data: movements, error: movementsError },
    { data: variances, error: variancesError },
    { data: unassigned, error: unassignedError },
    { data: receiptMovements, error: receiptMovementsError },
  ] = await Promise.all([
    listStockPositions(sb, userId, { tenantId, locationId: storeId, limit: 500 } as any),
    locationNameMap(sb, tenantId),
    sb
      .from("restaurant_purchase_orders")
      .select(
        "id, reference, document_number, status, supplier_id, expected_at, total, currency, created_by, approved_by, approved_at, created_at, metadata",
      )
      .eq("tenant_id", tenantId)
      .eq("location_id", storeId)
      .order("created_at", { ascending: false })
      .limit(100),
    sb
      .from("restaurant_goods_receipts")
      .select(
        "id, document_number, status, purchase_order_id, supplier_id, received_at, expected_at, posted_at, received_by, posted_by, accepted_value, currency, delivery_note_ref",
      )
      .eq("tenant_id", tenantId)
      .eq("location_id", storeId)
      .order("received_at", { ascending: false })
      .limit(100),
    sb
      .from("restaurant_stock_transfers")
      .select(
        "id, transfer_number, status, source_location_id, destination_location_id, dispatched_at, dispatched_by, received_at, received_by, total_value, currency, created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("source_location_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("restaurant_stock_transfers")
      .select(
        "id, transfer_number, status, source_location_id, destination_location_id, dispatched_at, dispatched_by, received_at, received_by, total_value, currency, created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("destination_location_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("restaurant_stock_movements")
      .select(
        "id, inventory_item_id, movement_type, quantity, unit_cost, total_cost, balance_after, reason, reference_type, reference_id, occurred_at, created_by, approved_by",
      )
      .eq("tenant_id", tenantId)
      .eq("location_id", storeId)
      .order("occurred_at", { ascending: false })
      .limit(50),
    sb
      .from("restaurant_procurement_variances")
      .select(
        "id, variance_type, severity, status, label, purchase_order_id, receipt_id, supplier_id, variance_value, currency, detected_at",
      )
      .eq("tenant_id", tenantId)
      .eq("location_id", storeId)
      .eq("status", "open")
      .order("detected_at", { ascending: false })
      .limit(50),
    // Legacy orders with neither a property nor a location: never treated as
    // central-store orders, always surfaced for resolution.
    sb
      .from("restaurant_purchase_orders")
      .select("id, reference, document_number, status, supplier_id, total, currency")
      .eq("tenant_id", tenantId)
      .is("property_id", null)
      .is("location_id", null)
      .in("status", ["draft", ...OPEN_PO])
      .limit(50),
    sb
      .from("restaurant_stock_movements")
      .select("reference_id, total_cost")
      .eq("tenant_id", tenantId)
      .eq("location_id", storeId)
      .eq("movement_type", "purchase_receipt")
      .eq("reference_type", "restaurant_goods_receipt")
      .limit(5000),
  ]);
  for (const e of [
    ordersError,
    receiptsError,
    outError,
    inError,
    movementsError,
    variancesError,
    unassignedError,
    receiptMovementsError,
  ]) {
    if (e) throw new Error(`Main Store overview could not load: ${e.message}`);
  }

  const orderRows = (orders ?? []) as any[];
  const unassignedRows = (unassigned ?? []) as any[];
  const allOrderIds = [...orderRows, ...unassignedRows].map((o) => o.id);
  const supplierIds = [
    ...orderRows.map((o) => o.supplier_id),
    ...unassignedRows.map((o) => o.supplier_id),
    ...((receipts ?? []) as any[]).map((r) => r.supplier_id),
  ].filter(Boolean) as string[];

  const transferRows = [...((transfersOut ?? []) as any[]), ...((transfersIn ?? []) as any[])];
  const transferIds = transferRows.map((t) => t.id);

  const [{ data: suppliers }, { data: orderLines }, { data: transferLines }, { data: items }] =
    await Promise.all([
      supplierIds.length
        ? sb
            .from("restaurant_suppliers")
            .select("id, name, status")
            .eq("tenant_id", tenantId)
            .in("id", [...new Set(supplierIds)])
        : Promise.resolve({ data: [] }),
      allOrderIds.length
        ? sb
            .from("restaurant_purchase_order_items")
            .select(
              "id, purchase_order_id, inventory_item_id, description, quantity, received_quantity, accepted_quantity, rejected_quantity, unit_price, line_total, price_exception_reason",
            )
            .eq("tenant_id", tenantId)
            .in("purchase_order_id", allOrderIds)
        : Promise.resolve({ data: [] }),
      transferIds.length
        ? sb
            .from("restaurant_stock_transfer_lines")
            .select(
              "id, transfer_id, inventory_item_id, requested_quantity, dispatched_quantity, received_quantity, rejected_quantity, damaged_quantity, unit_cost, notes",
            )
            .eq("tenant_id", tenantId)
            .in("transfer_id", transferIds)
        : Promise.resolve({ data: [] }),
      sb.from("restaurant_inventory_items").select("id, name").eq("tenant_id", tenantId),
    ]);

  const supplierById = new Map(((suppliers ?? []) as any[]).map((s) => [s.id, s]));
  const itemName = new Map(((items ?? []) as any[]).map((i) => [i.id, i.name]));
  const linesByOrder = new Map<string, any[]>();
  for (const l of (orderLines ?? []) as any[]) {
    if (!linesByOrder.has(l.purchase_order_id)) linesByOrder.set(l.purchase_order_id, []);
    linesByOrder.get(l.purchase_order_id)!.push(l);
  }
  const linesByTransfer = new Map<string, any[]>();
  for (const l of (transferLines ?? []) as any[]) {
    if (!linesByTransfer.has(l.transfer_id)) linesByTransfer.set(l.transfer_id, []);
    linesByTransfer.get(l.transfer_id)!.push(l);
  }

  const names = await userNames(sb, [
    ...orderRows.flatMap((o) => [o.created_by, o.approved_by]),
    ...((receipts ?? []) as any[]).flatMap((r) => [r.received_by, r.posted_by]),
    ...transferRows.flatMap((t) => [t.dispatched_by, t.received_by]),
    ...((movements ?? []) as any[]).map((m) => m.created_by),
  ]);
  const who = (id: string | null | undefined) => (id ? (names.get(id) ?? id) : null);

  // ---- stock position & valuation -----------------------------------------
  const stock = positions
    .filter((p) => p.locations.some((l) => l.locationId === storeId))
    .map((p) => ({
      itemId: p.itemId,
      name: p.name,
      onHand: p.onHand,
      reserved: p.reserved,
      available: p.available,
      averageCost: p.averageCost,
      value: round2(p.onHand * p.averageCost),
      currency: p.currency,
      low: p.low,
      lastMovementAt: p.lastMovementAt,
    }));
  const valuation = round2(stock.reduce((s, p) => s + p.value, 0));

  // ---- incoming purchase orders --------------------------------------------
  const incomingOrders = orderRows
    .filter((o) => OPEN_PO.includes(o.status))
    .map((o) => {
      const lines = linesByOrder.get(o.id) ?? [];
      return {
        id: o.id,
        reference: o.document_number ?? o.reference,
        status: o.status,
        supplier: supplierById.get(o.supplier_id)?.name ?? null,
        supplierStatus: supplierById.get(o.supplier_id)?.status ?? null,
        expectedAt: o.expected_at,
        total: num(o.total),
        currency: o.currency,
        raisedBy: who(o.created_by),
        approvedBy: who(o.approved_by),
        originatingPropertyId: o.metadata?.destination?.originating_property_id ?? null,
        lines: lines.map((l) => ({
          id: l.id,
          description: l.description,
          ordered: num(l.quantity),
          received: num(l.received_quantity),
          accepted: num(l.accepted_quantity),
          rejected: num(l.rejected_quantity),
          outstanding: Math.max(0, num(l.quantity) - num(l.received_quantity)),
          unitPrice: num(l.unit_price),
        })),
      };
    });

  // ---- goods receiving & supplier delivery performance ---------------------
  const receiptRows = ((receipts ?? []) as any[]).map((r) => ({
    id: r.id,
    reference: r.document_number,
    status: r.status,
    purchaseOrderId: r.purchase_order_id,
    supplier: supplierById.get(r.supplier_id)?.name ?? null,
    receivedAt: r.received_at,
    postedAt: r.posted_at,
    receivedBy: who(r.received_by),
    postedBy: who(r.posted_by),
    acceptedValue: num(r.accepted_value),
    currency: r.currency,
    deliveryNote: r.delivery_note_ref,
    onTime:
      r.expected_at && r.received_at
        ? String(r.received_at).slice(0, 10) <= String(r.expected_at).slice(0, 10)
        : null,
  }));
  const performance = new Map<
    string,
    { supplier: string; deliveries: number; onTime: number; dated: number; acceptedValue: number; openVariances: number }
  >();
  for (const r of (receipts ?? []) as any[]) {
    if (r.status !== "posted" || !r.supplier_id) continue;
    const p = performance.get(r.supplier_id) ?? {
      supplier: supplierById.get(r.supplier_id)?.name ?? r.supplier_id,
      deliveries: 0,
      onTime: 0,
      dated: 0,
      acceptedValue: 0,
      openVariances: 0,
    };
    p.deliveries += 1;
    p.acceptedValue = round2(p.acceptedValue + num(r.accepted_value));
    if (r.expected_at && r.received_at) {
      p.dated += 1;
      if (String(r.received_at).slice(0, 10) <= String(r.expected_at).slice(0, 10)) p.onTime += 1;
    }
    performance.set(r.supplier_id, p);
  }
  for (const v of (variances ?? []) as any[]) {
    const p = v.supplier_id ? performance.get(v.supplier_id) : undefined;
    if (p) p.openVariances += 1;
  }

  // ---- transfers -------------------------------------------------------------
  const transferView = (t: any) => {
    const lines = linesByTransfer.get(t.id) ?? [];
    return {
      id: t.id,
      reference: t.transfer_number,
      status: t.status,
      source: locations.get(t.source_location_id) ?? t.source_location_id,
      destination: locations.get(t.destination_location_id) ?? t.destination_location_id,
      dispatchedAt: t.dispatched_at,
      dispatchedBy: who(t.dispatched_by),
      receivedAt: t.received_at,
      receivedBy: who(t.received_by),
      value: num(t.total_value),
      currency: t.currency,
      lines: lines.map((l) => {
        const accounted = num(l.received_quantity) + num(l.rejected_quantity) + num(l.damaged_quantity);
        return {
          id: l.id,
          item: itemName.get(l.inventory_item_id) ?? "Item",
          requested: num(l.requested_quantity),
          dispatched: num(l.dispatched_quantity),
          received: num(l.received_quantity),
          rejected: num(l.rejected_quantity),
          damaged: num(l.damaged_quantity),
          accounted,
          inTransit: Math.max(0, num(l.dispatched_quantity) - accounted),
        };
      }),
    };
  };
  const incomingTransfers = ((transfersIn ?? []) as any[])
    .filter((t) => OPEN_TRANSFER.includes(t.status))
    .map(transferView);
  const outgoingTransfers = ((transfersOut ?? []) as any[])
    .filter((t) => OPEN_TRANSFER.includes(t.status))
    .map(transferView);
  const recentTransfers = transferRows
    .filter((t) => !OPEN_TRANSFER.includes(t.status))
    .slice(0, 20)
    .map(transferView);

  // Property allocation: what the Main Store has sent to each destination.
  const allocation = new Map<string, { destination: string; transfers: number; value: number }>();
  for (const t of (transfersOut ?? []) as any[]) {
    if (!["dispatched", "partially_received", "completed", "received"].includes(t.status)) continue;
    const key = t.destination_location_id;
    const a = allocation.get(key) ?? {
      destination: locations.get(key) ?? key,
      transfers: 0,
      value: 0,
    };
    a.transfers += 1;
    a.value = round2(a.value + num(t.total_value));
    allocation.set(key, a);
  }

  // ---- reconciliation: posted GRN value == ledger receipt value ------------
  const ledgerByReceipt = new Map<string, number>();
  for (const m of (receiptMovements ?? []) as any[]) {
    ledgerByReceipt.set(m.reference_id, (ledgerByReceipt.get(m.reference_id) ?? 0) + num(m.total_cost));
  }
  const postedReceipts = ((receipts ?? []) as any[]).filter((r) => r.status === "posted");
  const grnValue = round2(postedReceipts.reduce((s, r) => s + num(r.accepted_value), 0));
  const ledgerValue = round2(
    postedReceipts.reduce((s, r) => s + (ledgerByReceipt.get(r.id) ?? 0), 0),
  );

  // ---- exceptions -------------------------------------------------------------
  const exceptions: MainStoreException[] = [];
  for (const o of unassignedRows) {
    exceptions.push({
      kind: "unassigned_purchase_order",
      severity: "high",
      reference: o.document_number ?? o.reference,
      message: `${o.status} order has no destination. It cannot be submitted, approved or received until it is cancelled and re-raised to a destination.`,
      entityId: o.id,
    });
  }
  for (const o of [...orderRows.filter((x) => OPEN_PO.includes(x.status) || x.status === "draft"), ...unassignedRows]) {
    const supplier = supplierById.get(o.supplier_id);
    if (supplier && supplier.status !== "active") {
      exceptions.push({
        kind: "inactive_supplier_on_open_order",
        severity: "high",
        reference: o.document_number ?? o.reference,
        message: `Supplier ${supplier.name} is ${supplier.status}; the order cannot be submitted or approved.`,
        entityId: o.id,
      });
    }
    for (const l of linesByOrder.get(o.id) ?? []) {
      if (num(l.unit_price) <= 0 && !l.price_exception_reason) {
        exceptions.push({
          kind: "unpriced_order_line",
          severity: "high",
          reference: o.document_number ?? o.reference,
          message: `"${l.description}" has no unit price and no authorised zero-price exception.`,
          entityId: o.id,
        });
      }
    }
  }
  for (const t of [...incomingTransfers, ...outgoingTransfers]) {
    const inTransit = t.lines.reduce((s, l) => s + l.inTransit, 0);
    if (IN_TRANSIT.includes(t.status) && inTransit > 0) {
      exceptions.push({
        kind: "transfer_in_transit",
        severity: "medium",
        reference: t.reference,
        message: `${inTransit} unit(s) in transit ${t.source} → ${t.destination}; awaiting an authorised receipt.`,
        entityId: t.id,
      });
    }
  }
  for (const v of (variances ?? []) as any[]) {
    exceptions.push({
      kind: "open_variance",
      severity: v.severity === "high" ? "high" : "medium",
      reference: v.label,
      message: `Open ${v.variance_type} variance awaiting resolution.`,
      entityId: v.id,
    });
  }
  if (Math.abs(grnValue - ledgerValue) > 0.01) {
    exceptions.push({
      kind: "receipt_ledger_mismatch",
      severity: "high",
      reference: "Goods receiving",
      message: `Posted goods receipts total ${grnValue} but the stock ledger holds ${ledgerValue} of purchase receipts at the Main Store.`,
      entityId: null,
    });
  }

  return {
    active: true as const,
    status,
    stock,
    valuation,
    incomingOrders,
    receipts: receiptRows,
    supplierPerformance: [...performance.values()],
    incomingTransfers,
    outgoingTransfers,
    recentTransfers,
    allocation: [...allocation.values()],
    movements: ((movements ?? []) as any[]).map((m) => ({
      id: m.id,
      item: itemName.get(m.inventory_item_id) ?? "Item",
      type: m.movement_type,
      quantity: num(m.quantity),
      value: num(m.total_cost),
      balanceAfter: m.balance_after == null ? null : num(m.balance_after),
      reason: m.reason,
      occurredAt: m.occurred_at,
      by: who(m.created_by),
      approvedBy: who(m.approved_by),
    })),
    variances: (variances ?? []) as any[],
    reconciliation: {
      postedReceipts: postedReceipts.length,
      grnAcceptedValue: grnValue,
      ledgerReceiptValue: ledgerValue,
      reconciled: Math.abs(grnValue - ledgerValue) <= 0.01,
    },
    exceptions,
  };
}
