/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import {
  listPurchaseOrdersSchema,
  transitionPurchaseOrderSchema,
  type CreatePurchaseOrderInput,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { assertPurchaseOrderTransition } from "./state-machine";
import { nextDocumentNumber, recordProcurementAudit } from "../procurement/audit.server";
import { DOCUMENT_PREFIX } from "../procurement/contracts";
import type { PurchaseOrderStatus } from "../core/contracts";

type Sb = any;

export async function listPurchaseOrders(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listPurchaseOrdersSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_purchase_orders")
    .select("id, reference, status, supplier_id, order_date, expected_at, received_at, subtotal, total, currency, location_id")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createPurchaseOrder(sb: Sb, userId: string, input: CreatePurchaseOrderInput) {
  // A purchase order raised outside the requisition flow is a management
  // exception: it needs ordering authority, not just purchasing access.
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage");
  await assertCapability(sb, userId, input.tenantId, "purchasing.approve");

  const subtotal = input.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const documentNumber = await nextDocumentNumber(
    sb,
    input.tenantId,
    "purchase_order",
    DOCUMENT_PREFIX.purchase_order,
  );
  const reference = input.reference ?? documentNumber;

  const { data: po, error } = await sb
    .from("restaurant_purchase_orders")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      supplier_id: input.supplierId ?? null,
      reference,
      document_number: documentNumber,
      status: "draft",
      expected_at: input.expectedAt ?? null,
      subtotal,
      total: subtotal,
      currency: input.currency,
      notes: input.notes ?? null,
      created_by: userId,
      buyer_id: userId,
      metadata: { origin: "direct", direct_reason: input.directReason, authorised_by: userId },
    })
    .select("id, reference, document_number, total, currency")
    .single();
  if (error) throw new Error(error.message);

  if (input.lines.length > 0) {
    const { error: lineError } = await sb.from("restaurant_purchase_order_items").insert(
      input.lines.map((l) => ({
        tenant_id: input.tenantId,
        purchase_order_id: po.id,
        inventory_item_id: l.inventoryItemId ?? null,
        supplier_product_id: l.supplierProductId ?? null,
        unit_id: l.unitId ?? null,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        line_total: l.quantity * l.unitPrice,
      })),
    );
    if (lineError) throw new Error(lineError.message);
  }

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_order",
    documentId: po.id,
    documentNumber: po.document_number,
    action: "created_direct",
    newState: "draft",
    reason: input.directReason,
    metadata: { origin: "direct", lines: input.lines.length, subtotal },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.po.${po.id}.created`,
    payload: {
      reference: po.reference,
      document_number: po.document_number,
      total: Number(po.total),
      lines: input.lines.length,
      origin: "direct",
    },
  });
  return po;
}

/**
 * The single governed purchase-order transition service.
 *
 * State-machine validated, capability checked, tenant checked, idempotent and
 * audited. There is deliberately no generic "set status" path: fulfilment
 * states are derived from posted goods receipts, never asserted by a user.
 */
export async function transitionPurchaseOrder(
  sb: Sb,
  userId: string,
  input: z.infer<typeof transitionPurchaseOrderSchema>,
) {
  const capability = input.status === "approved" ? "purchasing.approve" : "purchasing.manage";
  await assertCapability(sb, userId, input.tenantId, capability);

  const { data: current, error: readErr } = await sb
    .from("restaurant_purchase_orders")
    .select("id, reference, document_number, status, total, location_id, property_id, correlation_id, created_by, buyer_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .single();
  if (readErr || !current) throw new Error("Purchase order not found.");

  // Idempotent: repeating the same decision is not a second business effect.
  if (current.status === input.status) {
    return {
      id: current.id,
      reference: current.reference,
      status: current.status,
      total: current.total,
      location_id: current.location_id,
      property_id: current.property_id,
      unchanged: true,
    };
  }

  assertPurchaseOrderTransition(current.status as PurchaseOrderStatus, input.status);

  if (input.status === "cancelled" && !input.reason) {
    throw new Error("A reason is required to cancel a purchase order.");
  }
  if (input.status === "approved" && (current.created_by === userId || current.buyer_id === userId)) {
    const { isPlatformAdmin } = await import("../core/access.server");
    if (!(await isPlatformAdmin(sb, userId))) {
      throw new Error("Separation of duties — the buyer who raised this order cannot approve it.");
    }
  }

  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() };
  if (input.status === "approved") {
    patch.approved_by = userId;
    patch.approved_at = new Date().toISOString();
  }

  const { data, error } = await sb
    .from("restaurant_purchase_orders")
    .update(patch)
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId)
    .eq("status", current.status)
    .select("id, reference, status, total, location_id, property_id")
    .single();
  if (error) throw new Error(error.message);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_order",
    documentId: input.id,
    documentNumber: current.document_number ?? current.reference,
    action: `transition_${input.status}`,
    previousState: current.status,
    newState: input.status,
    reason: input.reason ?? null,
    correlationId: current.correlation_id,
  });

  await emitRestaurantEvent(sb, userId, {
    type:
      input.status === "cancelled"
        ? "restaurant.purchase.order.cancelled"
        : input.status === "approved"
          ? "restaurant.purchase.order.approved"
          : "restaurant.purchase.order.submitted",
    tenantId: input.tenantId,
    propertyId: data.property_id ?? undefined,
    locationId: data.location_id ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: data.id,
    source: "restaurant-os",
    correlationId: current.correlation_id ?? undefined,
    dedupeKey: `restaurant.po.${data.id}.${input.status}`,
    payload: {
      reference: data.reference,
      document_number: current.document_number ?? null,
      total: Number(data.total),
      previous_status: current.status,
    },
  });
  return data;
}

/**
 * Document-centric read of one purchase order and everything that hangs off
 * it: ordered lines, what the supplier confirmed, what was actually received
 * and what we were invoiced. Read-only — no stage is collapsed into another.
 */
export async function getPurchaseOrderDetail(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertTenantRead(sb, userId, tenantId);

  const { data: order, error } = await sb
    .from("restaurant_purchase_orders")
    .select(
      "id, reference, document_number, status, confirmation_status, confirmed_at, supplier_reference, supplier_id, property_id, location_id, order_date, expected_at, received_at, subtotal, total, currency, notes",
    )
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .single();
  if (error || !order) throw new Error("Purchase order not found.");

  const [
    { data: items },
    { data: supplier },
    { data: confirmations },
    { data: receipts },
    { data: invoices },
  ] = await Promise.all([
    sb
      .from("restaurant_purchase_order_items")
      .select("id, inventory_item_id, unit_id, description, quantity, unit_price, line_total")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", id),
    order.supplier_id
      ? sb.from("restaurant_suppliers").select("id, name, code, payment_terms").eq("id", order.supplier_id).single()
      : Promise.resolve({ data: null }),
    sb
      .from("restaurant_supplier_confirmations")
      .select("id, status, supplier_reference, confirmed_delivery_date, notes, created_at")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", id)
      .order("created_at", { ascending: false }),
    sb
      .from("restaurant_goods_receipts")
      .select("id, document_number, status, received_at, accepted_value, currency, delivery_note_ref")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", id)
      .order("received_at", { ascending: false }),
    sb
      .from("restaurant_supplier_invoices")
      .select(
        "id, document_number, supplier_invoice_number, invoice_date, due_date, total, currency, status, match_status, payment_status",
      )
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", id)
      .order("invoice_date", { ascending: false }),
  ]);

  const confirmationIds = ((confirmations ?? []) as any[]).map((c) => c.id);
  const receiptIds = ((receipts ?? []) as any[]).map((r) => r.id);

  const [{ data: confirmationItems }, { data: receiptItems }] = await Promise.all([
    confirmationIds.length
      ? sb
          .from("restaurant_supplier_confirmation_items")
          .select(
            "id, confirmation_id, purchase_order_item_id, ordered_quantity, ordered_unit_price, confirmed_quantity, confirmed_unit_price, confirmed_delivery_date, notes",
          )
          .in("confirmation_id", confirmationIds)
      : Promise.resolve({ data: [] }),
    receiptIds.length
      ? sb
          .from("restaurant_goods_receipt_items")
          .select(
            "id, receipt_id, purchase_order_item_id, description, ordered_quantity, received_quantity, accepted_quantity, rejected_quantity, unit_cost",
          )
          .in("receipt_id", receiptIds)
      : Promise.resolve({ data: [] }),
  ]);

  const acceptedByOrderItem = new Map<string, number>();
  for (const r of (receiptItems ?? []) as any[]) {
    if (!r.purchase_order_item_id) continue;
    acceptedByOrderItem.set(
      r.purchase_order_item_id,
      (acceptedByOrderItem.get(r.purchase_order_item_id) ?? 0) + Number(r.accepted_quantity ?? 0),
    );
  }
  const latestConfirmation = ((confirmations ?? []) as any[])[0] ?? null;
  const confirmedByOrderItem = new Map<string, { quantity: number; unitPrice: number }>();
  for (const c of (confirmationItems ?? []) as any[]) {
    if (latestConfirmation && c.confirmation_id !== latestConfirmation.id) continue;
    confirmedByOrderItem.set(c.purchase_order_item_id, {
      quantity: Number(c.confirmed_quantity ?? 0),
      unitPrice: Number(c.confirmed_unit_price ?? 0),
    });
  }

  return {
    order,
    supplier: supplier ?? null,
    items: ((items ?? []) as any[]).map((i) => ({
      ...i,
      quantity: Number(i.quantity ?? 0),
      unit_price: Number(i.unit_price ?? 0),
      confirmed_quantity: confirmedByOrderItem.get(i.id)?.quantity ?? null,
      confirmed_unit_price: confirmedByOrderItem.get(i.id)?.unitPrice ?? null,
      accepted_quantity: acceptedByOrderItem.get(i.id) ?? 0,
    })),
    confirmations: (confirmations ?? []) as any[],
    confirmationItems: (confirmationItems ?? []) as any[],
    receipts: (receipts ?? []) as any[],
    receiptItems: (receiptItems ?? []) as any[],
    invoices: (invoices ?? []) as any[],
  };
}