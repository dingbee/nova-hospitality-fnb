/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Supplier confirmation. What the supplier agreed to is recorded separately
 * from what was ordered — the order is never silently rewritten.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { recordProcurementAudit } from "./audit.server";
import { recordPriceObservation } from "./pricing.server";
import { raiseVariance } from "./variances.server";
import type { RecordConfirmationInput } from "./contracts";

type Sb = any;

export async function recordSupplierConfirmation(sb: Sb, userId: string, input: RecordConfirmationInput) {
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage");

  const { data: po, error } = await sb
    .from("restaurant_purchase_orders")
    .select(
      "id, tenant_id, supplier_id, document_number, reference, status, currency, property_id, location_id, correlation_id, requested_delivery_date, supplier_reference, expected_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.purchaseOrderId)
    .single();
  if (error || !po) throw new Error("Purchase order not found.");
  if (!["submitted", "approved", "partially_received"].includes(po.status)) {
    throw new Error("Only an issued purchase order can be confirmed by a supplier.");
  }

  const { data: orderItems } = await sb
    .from("restaurant_purchase_order_items")
    .select("id, inventory_item_id, unit_id, description, quantity, unit_price")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_order_id", po.id);
  const ordered = new Map(((orderItems ?? []) as any[]).map((i) => [i.id, i]));

  const { data: confirmation, error: cErr } = await sb
    .from("restaurant_supplier_confirmations")
    .insert({
      tenant_id: input.tenantId,
      purchase_order_id: po.id,
      supplier_reference: input.supplierReference ?? null,
      status: input.status,
      confirmed_delivery_date: input.confirmedDeliveryDate ?? null,
      notes: input.notes ?? null,
      recorded_by: userId,
      correlation_id: po.correlation_id,
    })
    .select("id")
    .single();
  if (cErr) throw new Error(cErr.message);

  const lineRows = input.lines.map((l) => {
    const o = ordered.get(l.purchaseOrderItemId);
    return {
      tenant_id: input.tenantId,
      confirmation_id: confirmation.id,
      purchase_order_item_id: l.purchaseOrderItemId,
      inventory_item_id: (o?.inventory_item_id ?? null) as string | null,
      unit_id: (o?.unit_id ?? null) as string | null,
      ordered_quantity: Number(o?.quantity ?? 0),
      ordered_unit_price: Number(o?.unit_price ?? 0),
      confirmed_quantity: l.confirmedQuantity,
      confirmed_unit_price: l.confirmedUnitPrice,
      confirmed_delivery_date: l.confirmedDeliveryDate ?? null,
      notes: l.notes ?? null,
    };
  });
  if (lineRows.length > 0) {
    // The confirmation line table stores the agreement only; item identity stays on the order line.
    const { error: lErr } = await sb.from("restaurant_supplier_confirmation_items").insert(
      lineRows.map(({ inventory_item_id: _i, unit_id: _u, ...row }) => row),
    );
    if (lErr) throw new Error(lErr.message);
  }

  // Confirmed price and quantity differences are variances, not corrections.
  for (const row of lineRows) {
    if (row.ordered_quantity > 0 && row.confirmed_quantity !== row.ordered_quantity) {
      await raiseVariance(sb, userId, {
        tenantId: input.tenantId,
        propertyId: po.property_id,
        locationId: po.location_id,
        varianceType: "quantity",
        severity: row.confirmed_quantity < row.ordered_quantity ? "medium" : "low",
        label: `Supplier confirmed ${row.confirmed_quantity} of ${row.ordered_quantity} ordered`,
        purchaseOrderId: po.id,
        supplierId: po.supplier_id,
        expectedValue: row.ordered_quantity,
        actualValue: row.confirmed_quantity,
        currency: po.currency,
        detail: { stage: "confirmation", purchase_order_item_id: row.purchase_order_item_id },
        dedupeKey: `confirm-qty:${confirmation.id}:${row.purchase_order_item_id}`,
      });
    }
    if (row.ordered_unit_price > 0 && row.confirmed_unit_price !== row.ordered_unit_price) {
      await raiseVariance(sb, userId, {
        tenantId: input.tenantId,
        propertyId: po.property_id,
        locationId: po.location_id,
        varianceType: "price",
        severity:
          Math.abs(row.confirmed_unit_price - row.ordered_unit_price) / row.ordered_unit_price > 0.1
            ? "high"
            : "medium",
        label: `Supplier confirmed a different unit price`,
        purchaseOrderId: po.id,
        supplierId: po.supplier_id,
        expectedValue: row.ordered_unit_price,
        actualValue: row.confirmed_unit_price,
        currency: po.currency,
        detail: { stage: "confirmation", purchase_order_item_id: row.purchase_order_item_id },
        dedupeKey: `confirm-price:${confirmation.id}:${row.purchase_order_item_id}`,
      });
    }
    await recordPriceObservation(sb, {
      tenantId: input.tenantId,
      supplierId: po.supplier_id,
      inventoryItemId: row.inventory_item_id,
      unitId: row.unit_id,
      priceType: "quoted",
      price: row.confirmed_unit_price,
      quantity: row.confirmed_quantity,
      currency: po.currency ?? "TZS",
      sourceType: "supplier_confirmation",
      sourceId: confirmation.id,
      dedupeSuffix: row.purchase_order_item_id,
    });
  }

  // The order status tracks fulfilment; supplier agreement lives in its own field.
  const nextStatus = input.status === "declined" ? "cancelled" : po.status;
  await sb
    .from("restaurant_purchase_orders")
    .update({
      status: nextStatus,
      confirmation_status: input.status,
      confirmed_at: new Date().toISOString(),
      supplier_reference: input.supplierReference ?? po.supplier_reference ?? null,
      expected_at: input.confirmedDeliveryDate ?? po.expected_at ?? null,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", po.id);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_order",
    documentId: po.id,
    documentNumber: po.document_number ?? po.reference,
    action: "supplier_confirmed",
    previousState: po.status,
    newState: nextStatus,
    correlationId: po.correlation_id,
    metadata: {
      confirmation_id: confirmation.id,
      supplier_reference: input.supplierReference ?? null,
      confirmed_delivery_date: input.confirmedDeliveryDate ?? null,
    },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.order.confirmed",
    tenantId: input.tenantId,
    propertyId: po.property_id ?? undefined,
    locationId: po.location_id ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    correlationId: po.correlation_id ?? undefined,
    dedupeKey: `restaurant.po.${po.id}.confirmed.${confirmation.id}`,
    payload: {
      document_number: po.document_number ?? po.reference,
      confirmation_status: input.status,
      confirmed_delivery_date: input.confirmedDeliveryDate ?? null,
      lines: lineRows.length,
    },
  });

  return { id: confirmation.id, purchaseOrderStatus: nextStatus };
}
