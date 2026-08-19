/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Purchase requisitions — "what the business needs", kept distinct from what
 * was ordered. Not every request becomes a purchase order.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { nextDocumentNumber, recordProcurementAudit } from "./audit.server";
import { assertMayApprove } from "./approvals.server";
import { recordPriceObservation } from "./pricing.server";
import {
  DOCUMENT_PREFIX,
  type ConvertRequestToOrderInput,
  type SavePurchaseRequestInput,
  type TransitionPurchaseRequestInput,
  type listPurchaseRequestsSchema,
} from "./contracts";

type Sb = any;

const REQUEST_SELECT =
  "id, document_number, status, priority, category, reason, notes, currency, estimated_total, requested_by, requested_date, required_by_date, submitted_at, approved_at, approved_by, rejected_at, rejected_by, rejection_reason, converted_purchase_order_id, converted_at, property_id, location_id, correlation_id, version, created_at, updated_at";

export async function listPurchaseRequests(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listPurchaseRequestsSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_purchase_requests")
    .select(REQUEST_SELECT)
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

export async function getPurchaseRequest(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertTenantRead(sb, userId, tenantId);
  const [{ data: header, error }, { data: lines }, { data: audit }] = await Promise.all([
    sb.from("restaurant_purchase_requests").select(REQUEST_SELECT).eq("tenant_id", tenantId).eq("id", id).single(),
    sb
      .from("restaurant_purchase_request_items")
      .select(
        "id, inventory_item_id, unit_id, preferred_supplier_id, description, quantity, approved_quantity, estimated_unit_cost, estimated_total, justification, recommendation_ref",
      )
      .eq("tenant_id", tenantId)
      .eq("purchase_request_id", id)
      .order("created_at"),
    sb
      .from("restaurant_procurement_audit")
      .select("action, previous_state, new_state, reason, actor_id, created_at")
      .eq("tenant_id", tenantId)
      .eq("document_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (error) throw new Error(error.message);
  return { request: header, lines: lines ?? [], audit: audit ?? [] };
}

export async function savePurchaseRequest(sb: Sb, userId: string, input: SavePurchaseRequestInput) {
  await assertCapability(sb, userId, input.tenantId, "purchase.request");

  const estimatedTotal = input.lines.reduce((s, l) => s + l.quantity * (l.estimatedUnitCost ?? 0), 0);

  let requestId = input.id ?? null;
  let documentNumber: string;
  let previousState: string | null = null;

  if (requestId) {
    const { data: existing, error } = await sb
      .from("restaurant_purchase_requests")
      .select("id, status, document_number, version")
      .eq("tenant_id", input.tenantId)
      .eq("id", requestId)
      .single();
    if (error || !existing) throw new Error("Purchase request not found.");
    if (existing.status !== "draft") {
      throw new Error("Only draft requests can be edited — submitted history is never overwritten.");
    }
    previousState = existing.status;
    documentNumber = existing.document_number;
    const { error: upErr } = await sb
      .from("restaurant_purchase_requests")
      .update({
        property_id: input.propertyId ?? null,
        location_id: input.locationId ?? null,
        priority: input.priority,
        category: input.category ?? null,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        currency: input.currency,
        required_by_date: input.requiredByDate ?? null,
        estimated_total: estimatedTotal,
        version: Number(existing.version ?? 1) + 1,
      })
      .eq("id", requestId)
      .eq("tenant_id", input.tenantId);
    if (upErr) throw new Error(upErr.message);
    await sb
      .from("restaurant_purchase_request_items")
      .delete()
      .eq("tenant_id", input.tenantId)
      .eq("purchase_request_id", requestId);
  } else {
    documentNumber = await nextDocumentNumber(
      sb,
      input.tenantId,
      "purchase_request",
      DOCUMENT_PREFIX.purchase_request,
    );
    const { data: created, error } = await sb
      .from("restaurant_purchase_requests")
      .insert({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        location_id: input.locationId ?? null,
        document_number: documentNumber,
        status: "draft",
        priority: input.priority,
        category: input.category ?? null,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        currency: input.currency,
        estimated_total: estimatedTotal,
        requested_by: userId,
        required_by_date: input.requiredByDate ?? null,
      })
      .select("id, document_number, correlation_id")
      .single();
    if (error) throw new Error(error.message);
    requestId = created.id as string;
  }

  if (input.lines.length > 0) {
    const { error: lineErr } = await sb.from("restaurant_purchase_request_items").insert(
      input.lines.map((l) => ({
        tenant_id: input.tenantId,
        purchase_request_id: requestId,
        inventory_item_id: l.inventoryItemId ?? null,
        unit_id: l.unitId ?? null,
        preferred_supplier_id: l.preferredSupplierId ?? null,
        description: l.description,
        quantity: l.quantity,
        estimated_unit_cost: l.estimatedUnitCost ?? 0,
        estimated_total: l.quantity * (l.estimatedUnitCost ?? 0),
        justification: l.justification ?? null,
        recommendation_ref: l.recommendationRef ?? null,
      })),
    );
    if (lineErr) throw new Error(lineErr.message);
  }

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_request",
    documentId: requestId!,
    documentNumber,
    action: input.id ? "updated" : "created",
    previousState,
    newState: "draft",
    metadata: { lines: input.lines.length, estimated_total: estimatedTotal },
  });

  return { id: requestId!, documentNumber, estimatedTotal };
}

export async function transitionPurchaseRequest(
  sb: Sb,
  userId: string,
  input: TransitionPurchaseRequestInput,
) {
  const { data: req, error } = await sb
    .from("restaurant_purchase_requests")
    .select(
      "id, tenant_id, status, document_number, requested_by, estimated_total, priority, property_id, location_id, category, correlation_id",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .single();
  if (error || !req) throw new Error("Purchase request not found.");

  const patch: Record<string, unknown> = {};
  let newState = req.status as string;

  if (input.action === "submit") {
    await assertCapability(sb, userId, input.tenantId, "purchase.request");
    if (req.status !== "draft") throw new Error("Only a draft request can be submitted.");
    newState = "submitted";
    patch.status = newState;
    patch.submitted_at = new Date().toISOString();
    patch.submitted_by = userId;
  } else if (input.action === "cancel") {
    await assertCapability(sb, userId, input.tenantId, "purchase.request");
    if (["converted_to_po", "cancelled"].includes(req.status)) {
      throw new Error("This request can no longer be cancelled.");
    }
    newState = "cancelled";
    patch.status = newState;
    patch.cancelled_at = new Date().toISOString();
  } else {
    if (req.status !== "submitted") throw new Error("Only a submitted request can be decided.");
    await assertMayApprove(sb, userId, {
      tenantId: input.tenantId,
      documentType: "purchase_request",
      amount: Number(req.estimated_total ?? 0),
      requesterId: req.requested_by,
      propertyId: req.property_id,
      locationId: req.location_id,
      category: req.category,
    });
    if (input.action === "approve") {
      newState = "approved";
      patch.status = newState;
      patch.approved_at = new Date().toISOString();
      patch.approved_by = userId;
    } else {
      if (!input.reason) throw new Error("A rejection reason is required.");
      newState = "rejected";
      patch.status = newState;
      patch.rejected_at = new Date().toISOString();
      patch.rejected_by = userId;
      patch.rejection_reason = input.reason;
    }
  }

  const { error: upErr } = await sb
    .from("restaurant_purchase_requests")
    .update(patch)
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId);
  if (upErr) throw new Error(upErr.message);

  if (input.action === "approve" && input.approvedQuantities) {
    for (const [lineId, qty] of Object.entries(input.approvedQuantities)) {
      await sb
        .from("restaurant_purchase_request_items")
        .update({ approved_quantity: qty })
        .eq("tenant_id", input.tenantId)
        .eq("purchase_request_id", input.id)
        .eq("id", lineId);
    }
  }

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_request",
    documentId: input.id,
    documentNumber: req.document_number,
    action: input.action,
    previousState: req.status,
    newState,
    reason: input.reason ?? null,
    correlationId: req.correlation_id,
  });

  const eventType =
    input.action === "submit"
      ? "restaurant.purchase.requested"
      : input.action === "approve"
        ? "restaurant.purchase.request.approved"
        : input.action === "reject"
          ? "restaurant.purchase.request.rejected"
          : null;

  if (eventType) {
    await emitRestaurantEvent(sb, userId, {
      type: eventType,
      tenantId: input.tenantId,
      propertyId: req.property_id ?? undefined,
      locationId: req.location_id ?? undefined,
      entityType: "restaurant_purchase_request",
      entityId: input.id,
      source: "restaurant-os",
      correlationId: req.correlation_id ?? undefined,
      dedupeKey: `restaurant.pr.${input.id}.${newState}`,
      payload: {
        document_number: req.document_number,
        estimated_total: Number(req.estimated_total ?? 0),
        priority: req.priority ?? null,
      },
    });
  }

  return { id: input.id, status: newState };
}

/** Approved request → purchase order. The request is never mutated away. */
export async function convertRequestToOrder(sb: Sb, userId: string, input: ConvertRequestToOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage");

  const { data: req, error } = await sb
    .from("restaurant_purchase_requests")
    .select("id, status, document_number, currency, property_id, location_id, correlation_id, notes")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.requestId)
    .single();
  if (error || !req) throw new Error("Purchase request not found.");
  if (req.status !== "approved") throw new Error("Only an approved request can become a purchase order.");

  const { data: lines } = await sb
    .from("restaurant_purchase_request_items")
    .select("id, inventory_item_id, unit_id, description, quantity, approved_quantity, estimated_unit_cost")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_request_id", input.requestId);

  const orderLines = ((lines ?? []) as any[]).map((l) => ({
    quantity: Number(l.approved_quantity ?? l.quantity ?? 0),
    unitPrice: Number(l.estimated_unit_cost ?? 0),
    inventoryItemId: l.inventory_item_id,
    unitId: l.unit_id,
    description: l.description,
  }));

  const subtotal = orderLines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const documentNumber = await nextDocumentNumber(
    sb,
    input.tenantId,
    "purchase_order",
    DOCUMENT_PREFIX.purchase_order,
  );

  const { data: po, error: poErr } = await sb
    .from("restaurant_purchase_orders")
    .insert({
      tenant_id: input.tenantId,
      property_id: req.property_id,
      location_id: req.location_id,
      supplier_id: input.supplierId,
      purchase_request_id: input.requestId,
      reference: documentNumber,
      document_number: documentNumber,
      status: "draft",
      buyer_id: userId,
      requested_delivery_date: input.requestedDeliveryDate ?? null,
      payment_terms: input.paymentTerms ?? null,
      subtotal,
      total: subtotal,
      currency: req.currency ?? "TZS",
      notes: input.notes ?? req.notes ?? null,
      created_by: userId,
      correlation_id: req.correlation_id,
    })
    .select("id, document_number, total, currency")
    .single();
  if (poErr) throw new Error(poErr.message);

  if (orderLines.length > 0) {
    const { error: liErr } = await sb.from("restaurant_purchase_order_items").insert(
      orderLines.map((l) => ({
        tenant_id: input.tenantId,
        purchase_order_id: po.id,
        inventory_item_id: l.inventoryItemId,
        unit_id: l.unitId,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        line_total: l.quantity * l.unitPrice,
      })),
    );
    if (liErr) throw new Error(liErr.message);

    for (const l of orderLines) {
      await recordPriceObservation(sb, {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        inventoryItemId: l.inventoryItemId,
        unitId: l.unitId,
        priceType: "ordered",
        price: l.unitPrice,
        quantity: l.quantity,
        currency: req.currency ?? "TZS",
        sourceType: "purchase_order",
        sourceId: po.id,
      });
    }
  }

  await sb
    .from("restaurant_purchase_requests")
    .update({
      status: "converted_to_po",
      converted_purchase_order_id: po.id,
      converted_at: new Date().toISOString(),
    })
    .eq("id", input.requestId)
    .eq("tenant_id", input.tenantId);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_request",
    documentId: input.requestId,
    documentNumber: req.document_number,
    action: "converted_to_po",
    previousState: "approved",
    newState: "converted_to_po",
    correlationId: req.correlation_id,
    metadata: { purchase_order_id: po.id, purchase_order_number: po.document_number },
  });
  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "purchase_order",
    documentId: po.id,
    documentNumber: po.document_number,
    action: "created",
    newState: "draft",
    correlationId: req.correlation_id,
    metadata: { from_request: req.document_number, subtotal },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.order.created",
    tenantId: input.tenantId,
    propertyId: req.property_id ?? undefined,
    locationId: req.location_id ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    correlationId: req.correlation_id ?? undefined,
    dedupeKey: `restaurant.po.${po.id}.created`,
    payload: {
      document_number: po.document_number,
      total: Number(po.total ?? 0),
      from_request: req.document_number,
    },
  });

  return po;
}
