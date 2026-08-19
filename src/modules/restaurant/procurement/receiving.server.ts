/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Goods receiving. Physical delivery, acceptance and stock entry are three
 * distinct facts:
 *   received  = what arrived
 *   accepted  = what we kept  → the only quantity that enters inventory
 *   rejected/damaged = what we refused, kept for supplier performance
 *
 * Stock is only ever moved through the existing inventory ledger, with a
 * dedupe key per receipt line so posting is idempotent.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "../inventory/movements.server";
import {
  assertPurchaseOrderReceivable,
  resolveFulfilmentTransition,
} from "../purchasing/state-machine";
import { nextDocumentNumber, recordProcurementAudit } from "./audit.server";
import { recordPriceObservation } from "./pricing.server";
import { raiseVariance } from "./variances.server";
import {
  DOCUMENT_PREFIX,
  type CreateReceiptInput,
  type listReceiptsSchema,
} from "./contracts";

type Sb = any;

const RECEIPT_SELECT =
  "id, document_number, status, purchase_order_id, supplier_id, delivery_note_ref, received_at, expected_at, posted_at, currency, subtotal, accepted_value, notes, property_id, location_id, created_at";

export async function listGoodsReceipts(sb: Sb, userId: string, input: z.infer<typeof listReceiptsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_goods_receipts")
    .select(RECEIPT_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.purchaseOrderId) q = q.eq("purchase_order_id", input.purchaseOrderId);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getGoodsReceipt(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertTenantRead(sb, userId, tenantId);
  const [{ data: receipt, error }, { data: lines }, { data: variances }] = await Promise.all([
    sb.from("restaurant_goods_receipts").select(RECEIPT_SELECT).eq("tenant_id", tenantId).eq("id", id).single(),
    sb
      .from("restaurant_goods_receipt_items")
      .select(
        "id, purchase_order_item_id, inventory_item_id, unit_id, description, ordered_quantity, received_quantity, accepted_quantity, rejected_quantity, damaged_quantity, ordered_unit_cost, unit_cost, batch_code, expiry_date, rejection_reason, notes, stock_movement_id",
      )
      .eq("tenant_id", tenantId)
      .eq("receipt_id", id)
      .order("created_at"),
    sb
      .from("restaurant_procurement_variances")
      .select("id, variance_type, severity, status, label, expected_value, actual_value, variance_pct")
      .eq("tenant_id", tenantId)
      .eq("receipt_id", id),
  ]);
  if (error) throw new Error(error.message);
  return { receipt, lines: lines ?? [], variances: variances ?? [] };
}

/** Create a delivery record. Posting (stock entry) is a separate, explicit act. */
export async function createGoodsReceipt(sb: Sb, userId: string, input: CreateReceiptInput) {
  await assertCapability(sb, userId, input.tenantId, "receiving.manage");

  let po: any = null;
  if (input.purchaseOrderId) {
    const { data } = await sb
      .from("restaurant_purchase_orders")
      .select(
        "id, supplier_id, status, currency, property_id, location_id, document_number, reference, correlation_id, expected_at",
      )
      .eq("tenant_id", input.tenantId)
      .eq("id", input.purchaseOrderId)
      .single();
    if (!data) throw new Error("Purchase order not found.");
    // The state machine decides whether this order may receive at all.
    assertPurchaseOrderReceivable(data.status);
    po = data;
  }

  for (const l of input.lines) {
    if (l.acceptedQuantity + l.rejectedQuantity + l.damagedQuantity > l.receivedQuantity + 0.0001) {
      throw new Error(`"${l.description}": accepted + rejected + damaged cannot exceed the received quantity.`);
    }
    if ((l.rejectedQuantity > 0 || l.damagedQuantity > 0) && !l.rejectionReason) {
      throw new Error(`"${l.description}": a reason is required when quantities are rejected or damaged.`);
    }
  }

  // ---- over-receipt control ----------------------------------------------
  // Cumulative deliveries may never silently enlarge the order. Over-delivery
  // is allowed only as an explicitly authorised, reasoned exception.
  const overReceipts: Array<{ description: string; ordered: number; alreadyReceived: number; now: number }> = [];
  if (po) {
    const orderItemIds = input.lines.map((l) => l.purchaseOrderItemId).filter(Boolean) as string[];
    if (orderItemIds.length > 0) {
      const { data: poItems } = await sb
        .from("restaurant_purchase_order_items")
        .select("id, description, quantity, received_quantity")
        .eq("tenant_id", input.tenantId)
        .eq("purchase_order_id", po.id)
        .in("id", orderItemIds);
      const byId = new Map(((poItems ?? []) as any[]).map((i) => [i.id, i]));
      for (const l of input.lines) {
        if (!l.purchaseOrderItemId) continue;
        const poi = byId.get(l.purchaseOrderItemId);
        if (!poi) throw new Error(`"${l.description}": order line does not belong to this purchase order.`);
        const ordered = Number(poi.quantity ?? 0);
        const already = Number(poi.received_quantity ?? 0);
        if (already + l.receivedQuantity > ordered + 0.0001) {
          overReceipts.push({
            description: l.description,
            ordered,
            alreadyReceived: already,
            now: l.receivedQuantity,
          });
        }
      }
    }
  }
  if (overReceipts.length > 0) {
    if (!input.overReceiptReason) {
      const first = overReceipts[0]!;
      throw new Error(
        `"${first.description}": receiving ${first.now} would exceed the ordered ${first.ordered} (already received ${first.alreadyReceived}). An authorised over-receipt reason is required — the purchase order is never enlarged silently.`,
      );
    }
    // Over-receipt is a buying decision, so it needs ordering authority.
    await assertCapability(sb, userId, input.tenantId, "purchasing.approve");
  }

  const documentNumber = await nextDocumentNumber(
    sb,
    input.tenantId,
    "goods_receipt",
    DOCUMENT_PREFIX.goods_receipt,
  );
  const subtotal = input.lines.reduce((s, l) => s + l.receivedQuantity * l.unitCost, 0);
  const acceptedValue = input.lines.reduce((s, l) => s + l.acceptedQuantity * l.unitCost, 0);

  const { data: receipt, error } = await sb
    .from("restaurant_goods_receipts")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? po?.property_id ?? null,
      location_id: input.locationId ?? po?.location_id ?? null,
      purchase_order_id: po?.id ?? null,
      supplier_id: input.supplierId ?? po?.supplier_id ?? null,
      document_number: documentNumber,
      status: "draft",
      delivery_note_ref: input.deliveryNoteRef ?? null,
      received_at: input.receivedAt ?? new Date().toISOString(),
      expected_at: po?.expected_at ?? null,
      received_by: userId,
      currency: input.currency ?? po?.currency ?? "TZS",
      subtotal,
      accepted_value: acceptedValue,
      notes: input.notes ?? null,
      correlation_id: po?.correlation_id ?? null,
    })
    .select("id, document_number, status")
    .single();
  if (error) throw new Error(error.message);

  if (overReceipts.length > 0) {
    for (const o of overReceipts) {
      await raiseVariance(sb, userId, {
        tenantId: input.tenantId,
        propertyId: input.propertyId ?? po?.property_id ?? null,
        locationId: input.locationId ?? po?.location_id ?? null,
        varianceType: "quantity",
        severity: "high",
        label: `${o.description}: over-receipt — ${o.alreadyReceived + o.now} delivered against ${o.ordered} ordered`,
        purchaseOrderId: po?.id ?? null,
        receiptId: receipt.id,
        supplierId: input.supplierId ?? po?.supplier_id ?? null,
        expectedValue: o.ordered,
        actualValue: o.alreadyReceived + o.now,
        detail: { stage: "receiving", over_receipt: true, reason: input.overReceiptReason },
        dedupeKey: `receipt-over:${receipt.id}:${o.description}`,
      });
    }
    await recordProcurementAudit(sb, userId, {
      tenantId: input.tenantId,
      documentType: "goods_receipt",
      documentId: receipt.id,
      documentNumber,
      action: "over_receipt_authorised",
      reason: input.overReceiptReason ?? null,
      metadata: { lines: overReceipts },
    });
  }

  const { error: lineErr } = await sb.from("restaurant_goods_receipt_items").insert(
    input.lines.map((l) => ({
      tenant_id: input.tenantId,
      receipt_id: receipt.id,
      purchase_order_item_id: l.purchaseOrderItemId ?? null,
      inventory_item_id: l.inventoryItemId ?? null,
      unit_id: l.unitId ?? null,
      storage_location_id: l.storageLocationId ?? null,
      description: l.description,
      ordered_quantity: l.orderedQuantity,
      received_quantity: l.receivedQuantity,
      accepted_quantity: l.acceptedQuantity,
      rejected_quantity: l.rejectedQuantity,
      damaged_quantity: l.damagedQuantity,
      ordered_unit_cost: l.orderedUnitCost,
      unit_cost: l.unitCost,
      currency: input.currency ?? po?.currency ?? "TZS",
      batch_code: l.batchCode ?? null,
      expiry_date: l.expiryDate ?? null,
      rejection_reason: l.rejectionReason ?? null,
      notes: l.notes ?? null,
    })),
  );
  if (lineErr) throw new Error(lineErr.message);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "goods_receipt",
    documentId: receipt.id,
    documentNumber,
    action: "created",
    newState: "draft",
    correlationId: po?.correlation_id ?? null,
    metadata: { purchase_order: po?.document_number ?? po?.reference ?? null, lines: input.lines.length },
  });

  if (input.post) return postGoodsReceipt(sb, userId, input.tenantId, receipt.id);
  return { id: receipt.id, documentNumber, status: "draft" as const, posted: false };
}

/**
 * Post a receipt: accepted quantities enter the inventory ledger, variances are
 * raised, price history is written and the order's fulfilment state advances.
 */
export async function postGoodsReceipt(sb: Sb, userId: string, tenantId: string, receiptId: string) {
  await assertCapability(sb, userId, tenantId, "receiving.manage");

  const { data: receipt, error } = await sb
    .from("restaurant_goods_receipts")
    .select(
      "id, tenant_id, status, document_number, purchase_order_id, supplier_id, property_id, location_id, currency, received_at, expected_at, correlation_id",
    )
    .eq("tenant_id", tenantId)
    .eq("id", receiptId)
    .single();
  if (error || !receipt) throw new Error("Goods receipt not found.");
  if (receipt.status === "cancelled") throw new Error("A cancelled receipt cannot be posted.");
  if (receipt.status === "posted") {
    return { id: receipt.id, documentNumber: receipt.document_number, status: "posted" as const, posted: true };
  }

  // The order's right to receive is re-checked at posting time, before any
  // stock moves: a receipt drafted while the order was open must not resurrect
  // an order that has since been cancelled or completed.
  let orderStatusBefore: string | null = null;
  if (receipt.purchase_order_id) {
    const { data: order } = await sb
      .from("restaurant_purchase_orders")
      .select("id, status")
      .eq("tenant_id", tenantId)
      .eq("id", receipt.purchase_order_id)
      .single();
    if (!order) throw new Error("Purchase order not found.");
    assertPurchaseOrderReceivable(order.status);
    orderStatusBefore = order.status;
  }

  const { data: lines } = await sb
    .from("restaurant_goods_receipt_items")
    .select(
      "id, purchase_order_item_id, inventory_item_id, unit_id, storage_location_id, description, ordered_quantity, received_quantity, accepted_quantity, rejected_quantity, damaged_quantity, ordered_unit_cost, unit_cost, batch_code, expiry_date, batch_id",
    )
    .eq("tenant_id", tenantId)
    .eq("receipt_id", receipt.id);

  const rows = (lines ?? []) as any[];
  let acceptedValue = 0;

  for (const l of rows) {
    const accepted = Number(l.accepted_quantity ?? 0);
    const unitCost = Number(l.unit_cost ?? 0);
    acceptedValue += accepted * unitCost;

    if (accepted > 0 && l.inventory_item_id) {
      const moved = await insertMovement(sb, userId, {
        tenantId,
        propertyId: receipt.property_id,
        locationId: l.storage_location_id ?? receipt.location_id,
        inventoryItemId: l.inventory_item_id,
        unitId: l.unit_id,
        movementType: "purchase_receipt",
        quantity: Math.abs(accepted),
        unitCost,
        currency: receipt.currency ?? "TZS",
        reason: `Goods receipt ${receipt.document_number}`,
        referenceType: "restaurant_goods_receipt",
        referenceId: receipt.id,
        occurredAt: receipt.received_at,
        dedupeKey: `receipt:${receipt.id}:${l.id}`,
      });
      if (moved) {
        await sb
          .from("restaurant_goods_receipt_items")
          .update({ stock_movement_id: moved.id })
          .eq("tenant_id", tenantId)
          .eq("id", l.id);
      }

      // Lot traceability: the batch code and expiry captured at the door are
      // only useful if they survive into stock. Without this, a recall or an
      // expiry sweep has nothing to work from.
      await persistReceiptBatch(sb, userId, {
        tenantId,
        receipt,
        line: l,
        accepted,
        unitCost,
      });
    }

    // ---- variance detection (recorded, never auto-approved) ----
    const orderedQty = Number(l.ordered_quantity ?? 0);
    const receivedQty = Number(l.received_quantity ?? 0);
    if (orderedQty > 0 && Math.abs(receivedQty - orderedQty) > 0.0001) {
      await raiseVariance(sb, userId, {
        tenantId,
        propertyId: receipt.property_id,
        locationId: receipt.location_id,
        varianceType: "quantity",
        severity: receivedQty < orderedQty * 0.9 ? "high" : "medium",
        label: `${l.description}: received ${receivedQty} against ${orderedQty} ordered`,
        purchaseOrderId: receipt.purchase_order_id,
        receiptId: receipt.id,
        receiptItemId: l.id,
        supplierId: receipt.supplier_id,
        expectedValue: orderedQty,
        actualValue: receivedQty,
        detail: { stage: "receiving" },
        dedupeKey: `receipt-qty:${receipt.id}:${l.id}`,
      });
    }
    const orderedCost = Number(l.ordered_unit_cost ?? 0);
    if (orderedCost > 0 && Math.abs(unitCost - orderedCost) > 0.0001) {
      await raiseVariance(sb, userId, {
        tenantId,
        propertyId: receipt.property_id,
        locationId: receipt.location_id,
        varianceType: "price",
        severity: Math.abs(unitCost - orderedCost) / orderedCost > 0.1 ? "high" : "medium",
        label: `${l.description}: delivered at a different unit cost`,
        purchaseOrderId: receipt.purchase_order_id,
        receiptId: receipt.id,
        receiptItemId: l.id,
        supplierId: receipt.supplier_id,
        expectedValue: orderedCost,
        actualValue: unitCost,
        currency: receipt.currency,
        detail: { stage: "receiving" },
        dedupeKey: `receipt-price:${receipt.id}:${l.id}`,
      });
    }
    const rejected = Number(l.rejected_quantity ?? 0) + Number(l.damaged_quantity ?? 0);
    if (rejected > 0) {
      await raiseVariance(sb, userId, {
        tenantId,
        propertyId: receipt.property_id,
        locationId: receipt.location_id,
        varianceType: "quality",
        severity: "high",
        label: `${l.description}: ${rejected} rejected or damaged on delivery`,
        purchaseOrderId: receipt.purchase_order_id,
        receiptId: receipt.id,
        receiptItemId: l.id,
        supplierId: receipt.supplier_id,
        expectedValue: receivedQty,
        actualValue: Number(l.accepted_quantity ?? 0),
        detail: { stage: "receiving", rejected, damaged: Number(l.damaged_quantity ?? 0) },
        dedupeKey: `receipt-quality:${receipt.id}:${l.id}`,
      });
    }

    await recordPriceObservation(sb, {
      tenantId,
      supplierId: receipt.supplier_id,
      inventoryItemId: l.inventory_item_id,
      unitId: l.unit_id,
      priceType: "received",
      price: unitCost,
      quantity: receivedQty,
      currency: receipt.currency ?? "TZS",
      effectiveDate: String(receipt.received_at).slice(0, 10),
      sourceType: "goods_receipt",
      sourceId: receipt.id,
      dedupeSuffix: l.id,
    });

    // Cumulative fulfilment on the order line.
    if (l.purchase_order_item_id) {
      const { data: poi } = await sb
        .from("restaurant_purchase_order_items")
        .select("id, received_quantity, accepted_quantity, rejected_quantity")
        .eq("tenant_id", tenantId)
        .eq("id", l.purchase_order_item_id)
        .single();
      if (poi) {
        await sb
          .from("restaurant_purchase_order_items")
          .update({
            received_quantity: Number(poi.received_quantity ?? 0) + receivedQty,
            accepted_quantity: Number(poi.accepted_quantity ?? 0) + accepted,
            rejected_quantity: Number(poi.rejected_quantity ?? 0) + rejected,
          })
          .eq("tenant_id", tenantId)
          .eq("id", poi.id);
      }
    }
  }

  await sb
    .from("restaurant_goods_receipts")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
      accepted_value: acceptedValue,
    })
    .eq("tenant_id", tenantId)
    .eq("id", receipt.id);

  // Order fulfilment state: receiving establishes the business fact (how much
  // arrived); the purchase-order state machine decides whether — and to what —
  // the lifecycle state may move. Re-read the status so a concurrent
  // cancellation is still respected.
  let orderStatus: string | null = null;
  if (receipt.purchase_order_id) {
    const { data: poItems } = await sb
      .from("restaurant_purchase_order_items")
      .select("quantity, received_quantity")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", receipt.purchase_order_id);
    const items = (poItems ?? []) as any[];
    const complete =
      items.length > 0 &&
      items.every((i) => Number(i.received_quantity ?? 0) >= Number(i.quantity ?? 0) - 0.0001);

    const { data: current } = await sb
      .from("restaurant_purchase_orders")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", receipt.purchase_order_id)
      .single();
    const from = (current?.status ?? orderStatusBefore) as any;
    const target = complete ? "received" : "partially_received";

    // Throws for a cancelled or already-received order; returns null when the
    // order is already in the target state (a further partial delivery).
    const next = resolveFulfilmentTransition(from, target);
    orderStatus = next ?? from;
    if (next) {
      await sb
        .from("restaurant_purchase_orders")
        .update({ status: next, received_at: next === "received" ? new Date().toISOString() : null })
        .eq("tenant_id", tenantId)
        .eq("id", receipt.purchase_order_id)
        // Optimistic guard: only move the order we actually evaluated.
        .eq("status", from);
    }
  }

  await recordProcurementAudit(sb, userId, {
    tenantId,
    documentType: "goods_receipt",
    documentId: receipt.id,
    documentNumber: receipt.document_number,
    action: "posted",
    previousState: "draft",
    newState: "posted",
    correlationId: receipt.correlation_id,
    metadata: { accepted_value: acceptedValue, lines: rows.length, order_status: orderStatus },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.received",
    tenantId,
    propertyId: receipt.property_id ?? undefined,
    locationId: receipt.location_id ?? undefined,
    entityType: "restaurant_goods_receipt",
    entityId: receipt.id,
    source: "restaurant-os",
    correlationId: receipt.correlation_id ?? undefined,
    dedupeKey: `restaurant.receipt.${receipt.id}.posted`,
    payload: {
      document_number: receipt.document_number,
      accepted_value: acceptedValue,
      lines: rows.length,
      supplier_id: receipt.supplier_id,
      order_status: orderStatus,
    },
  });

  return {
    id: receipt.id,
    documentNumber: receipt.document_number,
    status: "posted" as const,
    posted: true,
    acceptedValue,
    orderStatus,
  };
}

/**
 * Writes (or completes) the stock batch a receipt line created.
 *
 * Idempotent by receipt line: reposting or retrying a receipt never duplicates
 * a lot. Batches are recorded when the item is lot-tracked, or whenever the
 * receiver actually captured a lot code or an expiry date — a captured expiry
 * that is thrown away is worse than none at all.
 */
async function persistReceiptBatch(
  sb: Sb,
  userId: string,
  args: { tenantId: string; receipt: any; line: any; accepted: number; unitCost: number },
): Promise<void> {
  const { tenantId, receipt, line, accepted, unitCost } = args;

  const { data: item } = await sb
    .from("restaurant_inventory_items")
    .select("id, track_batches")
    .eq("tenant_id", tenantId)
    .eq("id", line.inventory_item_id)
    .maybeSingle();

  const captured = Boolean(line.batch_code) || Boolean(line.expiry_date);
  if (!captured && !item?.track_batches) return;

  const { data: existing } = await sb
    .from("restaurant_inventory_batches")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("reference_type", "restaurant_goods_receipt_item")
    .eq("reference_id", line.id)
    .maybeSingle();
  if (existing) return;

  const batchNumber =
    (line.batch_code as string | null) ?? `${receipt.document_number ?? "GRN"}-${String(line.id).slice(0, 8)}`;

  const { data: batch, error } = await sb
    .from("restaurant_inventory_batches")
    .insert({
      tenant_id: tenantId,
      property_id: receipt.property_id ?? null,
      location_id: line.storage_location_id ?? receipt.location_id ?? null,
      inventory_item_id: line.inventory_item_id,
      supplier_id: receipt.supplier_id ?? null,
      batch_number: batchNumber,
      received_date: (receipt.received_at ?? new Date().toISOString()).slice(0, 10),
      expiry_date: line.expiry_date ?? null,
      quantity: accepted,
      unit_id: line.unit_id ?? null,
      unit_cost: unitCost,
      status: "active",
      reference_type: "restaurant_goods_receipt_item",
      reference_id: line.id,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await sb
    .from("restaurant_goods_receipt_items")
    .update({ batch_id: batch.id })
    .eq("tenant_id", tenantId)
    .eq("id", line.id);
}
