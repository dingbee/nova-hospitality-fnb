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
import { assertMayApprove } from "../procurement/approvals.server";
import {
  insertWithUniqueDocumentNumber,
  recordProcurementAudit,
} from "../procurement/audit.server";
import { DOCUMENT_PREFIX } from "../procurement/contracts";
import { assertCurrency, priceOrderLines } from "./governance";
import {
  assertPurchaseOrderCommitmentReady,
  assertSupplierEligible,
  assertSupplierProductsBelongToSupplier,
  resolvePurchaseOrderDestination,
} from "./governance.server";
import type { PurchaseOrderStatus } from "../core/contracts";

type Sb = any;

/** The exact Postgres constraint name from restaurant_purchase_orders' `UNIQUE (tenant_id, reference)`. */
const PO_REFERENCE_CONSTRAINT = "restaurant_purchase_orders_tenant_id_reference_key";

export async function listPurchaseOrders(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listPurchaseOrdersSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_purchase_orders")
    .select(
      "id, reference, document_number, status, supplier_id, order_date, expected_at, received_at, subtotal, total, currency, property_id, location_id, purchase_request_id, metadata",
    )
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
  // Destination first: an order is never created unassigned. In central-store
  // mode an omitted destination resolves to the tenant Main Store.
  const destination = await resolvePurchaseOrderDestination(sb, input.tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });

  // A purchase order raised outside the requisition flow is a management
  // exception: it needs ordering authority, not just purchasing access —
  // at the resolved destination (a central-store order needs a tenant-wide grant).
  const scope = {
    propertyId: destination.propertyId,
    locationId: destination.locationId,
    tenantWide: destination.centralStore || undefined,
  };
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage", scope);
  await assertCapability(sb, userId, input.tenantId, "purchasing.approve", scope);
  // The originating property (if any) must itself be within the caller's scope.
  if (destination.originatingPropertyId && destination.centralStore) {
    await assertCapability(sb, userId, input.tenantId, "purchasing.manage", {
      propertyId: destination.originatingPropertyId,
    });
  }

  const currency = assertCurrency(input.currency);
  if (input.supplierId) await assertSupplierEligible(sb, input.tenantId, input.supplierId);
  await assertSupplierProductsBelongToSupplier(
    sb,
    input.tenantId,
    input.supplierId ?? null,
    currency,
    input.lines.map((l) => l.supplierProductId).filter(Boolean) as string[],
  );

  // Every amount is calculated here; nothing the client totals is trusted.
  const priced = priceOrderLines(input.lines);
  const subtotal = priced.subtotal;
  const now = new Date().toISOString();

  // An explicit reference is client-supplied (e.g. a supplier's own PO
  // number) and never comes from the sequence — a retry that resubmits the
  // same value must fail fast with a clear, actionable error instead of
  // burning a document number on an insert that was always going to fail.
  if (input.reference) {
    const { data: existing } = await sb
      .from("restaurant_purchase_orders")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("reference", input.reference)
      .maybeSingle();
    if (existing) {
      throw new Error(`A purchase order with reference "${input.reference}" already exists.`);
    }
  }

  const po = await insertWithUniqueDocumentNumber(
    sb,
    input.tenantId,
    "purchase_order",
    DOCUMENT_PREFIX.purchase_order,
    PO_REFERENCE_CONSTRAINT,
    (documentNumber) =>
      sb
        .from("restaurant_purchase_orders")
        .insert({
          tenant_id: input.tenantId,
          property_id: destination.propertyId,
          location_id: destination.locationId,
          supplier_id: input.supplierId ?? null,
          reference: input.reference ?? documentNumber,
          document_number: documentNumber,
          status: "draft",
          expected_at: input.expectedAt ?? null,
          subtotal,
          total: subtotal,
          currency,
          notes: input.notes ?? null,
          created_by: userId,
          buyer_id: userId,
          metadata: {
            origin: "direct",
            direct_reason: input.directReason,
            authorised_by: userId,
            destination: {
              central_store: destination.centralStore,
              resolved_by: destination.resolvedBy,
              originating_property_id: destination.originatingPropertyId,
            },
          },
        })
        .select("id, reference, document_number, total, currency")
        .single(),
    // A pre-checked explicit reference should never be silently replaced by
    // a regenerated one on a rare TOCTOU collision — surface that as a real
    // error immediately rather than retrying with a different value.
    { retryOnCollision: !input.reference },
  );

  if (priced.lines.length > 0) {
    const { error: lineError } = await sb.from("restaurant_purchase_order_items").insert(
      priced.lines.map((l, i) => ({
        tenant_id: input.tenantId,
        purchase_order_id: po.id,
        inventory_item_id: input.lines[i]!.inventoryItemId ?? null,
        supplier_product_id: input.lines[i]!.supplierProductId ?? null,
        unit_id: input.lines[i]!.unitId ?? null,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        line_total: l.lineTotal,
        price_exception_reason: l.priceExceptionReason,
        price_exception_authorised_by: l.priceExceptionReason ? userId : null,
        price_exception_authorised_at: l.priceExceptionReason ? now : null,
      })),
    );
    if (lineError) throw new Error(lineError.message);
  }
  const priceExceptions = priced.lines.filter((l) => l.priceExceptionReason);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_order",
    documentId: po.id,
    documentNumber: po.document_number,
    action: "created_direct",
    newState: "draft",
    reason: input.directReason,
    metadata: {
      origin: "direct",
      lines: priced.lines.length,
      subtotal,
      destination_location_id: destination.locationId,
      destination_property_id: destination.propertyId,
      central_store: destination.centralStore,
      originating_property_id: destination.originatingPropertyId,
    },
  });
  if (priceExceptions.length > 0) {
    await recordProcurementAudit(sb, userId, {
      tenantId: input.tenantId,
      documentType: "purchase_order",
      documentId: po.id,
      documentNumber: po.document_number,
      action: "zero_price_exception_authorised",
      newState: "draft",
      reason: priceExceptions.map((l) => `${l.description}: ${l.priceExceptionReason}`).join("; "),
      metadata: { lines: priceExceptions.map((l) => l.description) },
    });
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.created",
    tenantId: input.tenantId,
    propertyId: destination.propertyId ?? undefined,
    locationId: destination.locationId ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.po.${po.id}.created`,
    payload: {
      reference: po.reference,
      document_number: po.document_number,
      total: Number(po.total),
      lines: priced.lines.length,
      origin: "direct",
      central_store: destination.centralStore,
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

  const { data: current, error: readErr } = await sb
    .from("restaurant_purchase_orders")
    .select(
      "id, reference, document_number, status, total, location_id, property_id, correlation_id, created_by, buyer_id",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .single();
  if (readErr || !current) throw new Error("Purchase order not found.");
  // A NULL property is never a tenant-wide bypass: an order without a
  // property (central-store or legacy unassigned) needs a tenant-wide grant.
  await assertCapability(sb, userId, input.tenantId, capability, {
    propertyId: current.property_id ?? null,
    locationId: current.location_id ?? null,
    tenantWide: current.property_id ? undefined : true,
  });

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
  if (input.status === "approved") {
    const requesterId =
      current.created_by === userId || current.buyer_id === userId
        ? userId
        : (current.buyer_id ?? current.created_by ?? null);
    await assertMayApprove(sb, userId, {
      tenantId: input.tenantId,
      documentType: "purchase_order",
      amount: Number(current.total ?? 0),
      requesterId,
      propertyId: current.property_id ?? null,
      locationId: current.location_id ?? null,
    });
  }

  // Authorization is decided first (above); then submission and approval
  // re-validate the order against CURRENT supplier status, destination and
  // pricing rules — an order created before a supplier was deactivated is
  // never silently carried into a commitment.
  if (input.status === "submitted" || input.status === "approved") {
    await assertPurchaseOrderCommitmentReady(sb, input.tenantId, input.id);
  }

  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
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
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error(
      "The purchase order changed while this decision was being made — reload and try again.",
    );
  }

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
      ? sb
          .from("restaurant_suppliers")
          .select("id, name, code, payment_terms")
          .eq("id", order.supplier_id)
          .single()
      : Promise.resolve({ data: null }),
    sb
      .from("restaurant_supplier_confirmations")
      .select("id, status, supplier_reference, confirmed_delivery_date, notes, created_at")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", id)
      .order("created_at", { ascending: false }),
    sb
      .from("restaurant_goods_receipts")
      .select(
        "id, document_number, status, received_at, accepted_value, currency, delivery_note_ref",
      )
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
