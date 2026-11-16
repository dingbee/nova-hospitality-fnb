/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Purchase requisitions — "what the business needs", kept distinct from what
 * was ordered. Not every request becomes a purchase order.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { getPurchasingIntelligence } from "../intelligence/purchasing.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  insertWithUniqueDocumentNumber,
  nextDocumentNumber,
  recordProcurementAudit,
} from "./audit.server";
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
    sb
      .from("restaurant_purchase_requests")
      .select(REQUEST_SELECT)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .single(),
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

  const estimatedTotal = input.lines.reduce(
    (s, l) => s + l.quantity * (l.estimatedUnitCost ?? 0),
    0,
  );

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
      throw new Error(
        "Only draft requests can be edited — submitted history is never overwritten.",
      );
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
export async function convertRequestToOrder(
  sb: Sb,
  userId: string,
  input: ConvertRequestToOrderInput,
) {
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage");

  const { data: req, error } = await sb
    .from("restaurant_purchase_requests")
    .select("id, status, document_number, currency, property_id, location_id, correlation_id, notes, metadata, converted_purchase_order_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.requestId)
    .single();
  if (error || !req) throw new Error("Purchase request not found.");
  if (!["approved", "converted_to_po"].includes(req.status)) {
    throw new Error("Only an approved request can become a purchase order.");
  }
  if (typeof req.currency !== "string" || !/^[A-Z]{3}$/.test(req.currency)) {
    throw new Error("The approved request has no valid configured currency.");
  }

  const { data: lines, error: linesError } = await sb
    .from("restaurant_purchase_request_items")
    .select("id, inventory_item_id, preferred_supplier_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, minimum_order_quantity, order_multiple, source_action_id, description, quantity, approved_quantity, estimated_unit_cost")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_request_id", input.requestId);
  if (linesError) throw new Error("Unable to load approved purchase-request lines: " + linesError.message);

  const orderLines = ((lines ?? []) as any[]).map((line) => {
    const quantity = Number(line.approved_quantity ?? line.quantity ?? 0);
    const unitPrice = Number(line.estimated_unit_cost ?? 0);
    const stockFactor = line.stock_units_per_purchase_unit == null ? null : Number(line.stock_units_per_purchase_unit);
    const minimumOrderQuantity = line.minimum_order_quantity == null ? null : Number(line.minimum_order_quantity);
    const orderMultiple = line.order_multiple == null ? null : Number(line.order_multiple);
    if (!line.inventory_item_id || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error("An approved purchase-request line has invalid item, quantity or price data.");
    }
    if (line.supplier_product_id && (!line.unit_id || !line.stock_unit_id || stockFactor == null ||
        !Number.isFinite(stockFactor) || stockFactor <= 0 || orderMultiple == null ||
        !Number.isFinite(orderMultiple) || orderMultiple <= 0)) {
      throw new Error("A supplier-linked request line is missing its immutable purchase-to-stock conversion or order-multiple snapshot.");
    }
    if (stockFactor != null && (!line.stock_unit_id || !Number.isFinite(stockFactor) || stockFactor <= 0)) {
      throw new Error("A purchase-request line has an invalid stock-unit conversion snapshot.");
    }
    if (minimumOrderQuantity != null && (!Number.isFinite(minimumOrderQuantity) ||
        minimumOrderQuantity < 0 || quantity < minimumOrderQuantity)) {
      throw new Error("Approved quantity is below the stored supplier minimum order quantity.");
    }
    if (orderMultiple != null && (!Number.isFinite(orderMultiple) || orderMultiple <= 0 ||
        Math.abs(quantity / orderMultiple - Math.round(quantity / orderMultiple)) > 0.000001)) {
      throw new Error("Approved quantity does not satisfy the stored supplier order multiple.");
    }
    if (line.preferred_supplier_id && line.preferred_supplier_id !== input.supplierId) {
      throw new Error("The selected PO supplier differs from the supplier approved on a request line.");
    }
    return {
      requestItemId: line.id,
      inventoryItemId: line.inventory_item_id,
      supplierProductId: line.supplier_product_id ?? null,
      supplierId: line.preferred_supplier_id ?? input.supplierId,
      unitId: line.unit_id ?? null,
      stockUnitId: line.stock_unit_id ?? null,
      stockUnitsPerPurchaseUnit: stockFactor,
      minimumOrderQuantity,
      orderMultiple,
      sourceActionId: line.source_action_id ?? null,
      quantity,
      unitPrice,
      description: line.description,
    };
  });
  if (orderLines.length === 0) throw new Error("An approved purchase request must contain at least one line.");

  const intelligentLines = orderLines.filter((line) => line.sourceActionId);
  if (intelligentLines.length > 0) {
    if (!req.location_id || intelligentLines.length !== 1) {
      throw new Error("An intelligence-generated request requires one explicit delivery location and one source recommendation.");
    }
    const recommendation = (req.metadata as any)?.inventory_recommendation;
    if (!recommendation || recommendation.inventory_item_id !== intelligentLines[0].inventoryItemId) {
      throw new Error("The intelligence-generated request is missing its durable recommendation evidence.");
    }
    const fresh = await getPurchasingIntelligence(sb, userId, {
      tenantId: input.tenantId,
      windowDays: 30,
      propertyId: req.property_id ?? null,
      locationId: req.location_id,
    });
    const freshSuggestion = fresh.suggestions.find((row) => row.inventoryItemId === intelligentLines[0].inventoryItemId);
    const sameNumber = (a: unknown, b: unknown) =>
      Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 0.0001;
    if (
      !freshSuggestion ||
      freshSuggestion.supplierId !== intelligentLines[0].supplierId ||
      freshSuggestion.supplierProductId !== recommendation.supplier_product_id ||
      freshSuggestion.purchaseUnitId !== recommendation.purchase_unit_id ||
      freshSuggestion.stockUnitId !== recommendation.stock_unit_id ||
      !sameNumber(freshSuggestion.purchaseQuantity, recommendation.purchase_quantity) ||
      !sameNumber(freshSuggestion.purchaseUnitPrice, recommendation.purchase_unit_price) ||
      !sameNumber(freshSuggestion.stockUnitsPerPurchaseUnit, recommendation.stock_units_per_purchase_unit) ||
      !sameNumber(freshSuggestion.minimumOrderQuantity ?? 0, recommendation.minimum_order_quantity ?? 0) ||
      freshSuggestion.orderMultiple == null || recommendation.order_multiple == null ||
      !sameNumber(freshSuggestion.orderMultiple, recommendation.order_multiple) ||
      !sameNumber(freshSuggestion.recommendedQuantity, recommendation.recommended_stock_quantity) ||
      !sameNumber(freshSuggestion.netAvailable, recommendation.net_available) ||
      !sameNumber(freshSuggestion.forecastDemand, recommendation.forecast_demand) ||
      !sameNumber(freshSuggestion.safetyStock, recommendation.safety_stock) ||
      !sameNumber(freshSuggestion.dailyVelocity, recommendation.daily_velocity) ||
      !sameNumber(freshSuggestion.leadTimeDays, recommendation.lead_time_days) ||
      !sameNumber(freshSuggestion.targetCoverageDays, recommendation.target_coverage_days) ||
      freshSuggestion.demandObservations !== recommendation.demand_observations ||
      freshSuggestion.effectivePriceDate !== (recommendation.effective_price_date ?? null) ||
      freshSuggestion.forecastConfidence !== recommendation.forecast_confidence ||
      freshSuggestion.purchaseCurrency !== recommendation.currency ||
      req.currency !== recommendation.currency
    ) {
      throw new Error("The approved inventory recommendation is stale. Regenerate and reapprove the request before converting it to a purchase order.");
    }
  }

  const subtotal = Number(orderLines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0).toFixed(4));
  const { data: existingPo, error: existingPoError } = await sb
    .from("restaurant_purchase_orders")
    .select("id, document_number, reference, status, supplier_id, property_id, location_id, purchase_request_id, total, currency, metadata")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_request_id", input.requestId)
    .maybeSingle();
  if (existingPoError) throw new Error("Unable to check for an existing purchase order: " + existingPoError.message);
  let recoveredByConvertedId: any = null;
  if (!existingPo && req.converted_purchase_order_id) {
    const { data: convertedPo, error: convertedPoError } = await sb
      .from("restaurant_purchase_orders")
      .select("id, document_number, reference, status, supplier_id, property_id, location_id, purchase_request_id, total, currency, metadata")
      .eq("tenant_id", input.tenantId)
      .eq("id", req.converted_purchase_order_id)
      .maybeSingle();
    if (convertedPoError) throw new Error("Unable to recover the request's converted purchase order: " + convertedPoError.message);
    recoveredByConvertedId = convertedPo;
  }
  const resolvedExistingPo = existingPo ?? recoveredByConvertedId;
  if (req.status === "converted_to_po" && !resolvedExistingPo) {
    throw new Error("The request is marked converted but its purchase order cannot be found. Manual reconciliation is required.");
  }

  let po: any = resolvedExistingPo;
  let poCreated = false;
  if (!po) {
    try {
      po = await insertWithUniqueDocumentNumber(
        sb,
        input.tenantId,
        "purchase_order",
        DOCUMENT_PREFIX.purchase_order,
        "restaurant_purchase_orders_tenant_id_reference_key",
        (documentNumber) =>
          sb
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
              currency: req.currency,
              notes: input.notes ?? req.notes ?? null,
              created_by: userId,
              correlation_id: req.correlation_id,
              metadata: {
                source: "purchase_request",
                purchase_request_id: input.requestId,
                decision_id: (req.metadata as any)?.decision_id ?? null,
                action_id: (req.metadata as any)?.action_id ?? null,
              },
            })
            .select("id, document_number, total, currency, status, supplier_id, property_id, location_id, purchase_request_id, metadata")
            .single(),
      );
      poCreated = true;
    } catch (createError) {
      const message = (createError as Error).message ?? "Purchase order creation failed.";
      if (!message.includes("idx_restaurant_purchase_orders_purchase_request")) throw createError;
      const { data: recoveredPo, error: recoverError } = await sb
        .from("restaurant_purchase_orders")
        .select("id, document_number, reference, status, supplier_id, property_id, location_id, purchase_request_id, total, currency, metadata")
        .eq("tenant_id", input.tenantId)
        .eq("purchase_request_id", input.requestId)
        .maybeSingle();
      if (recoverError || !recoveredPo) {
        throw new Error(recoverError?.message ?? "Concurrent purchase-order creation could not be recovered.");
      }
      po = recoveredPo;
    }
  }

  if ((po.purchase_request_id && po.purchase_request_id !== input.requestId) || po.supplier_id !== input.supplierId ||
      po.property_id !== req.property_id || po.location_id !== req.location_id || po.currency !== req.currency) {
    throw new Error("An existing purchase order linked to this request has conflicting supplier, property, location or currency scope.");
  }

  const { data: existingLines, error: existingLinesError } = await sb
    .from("restaurant_purchase_order_items")
    .select("id, source_request_item_id, source_action_id, inventory_item_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, minimum_order_quantity, order_multiple, quantity, unit_price")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_order_id", po.id);
  if (existingLinesError) throw new Error("Unable to verify existing purchase-order lines: " + existingLinesError.message);
  const existingByRequestItem = new Map(
    ((existingLines ?? []) as any[])
      .filter((line) => line.source_request_item_id)
      .map((line) => [line.source_request_item_id, line]),
  );
  const expectedRequestItemIds = new Set(orderLines.map((line) => line.requestItemId));
  if (((existingLines ?? []) as any[]).some((line) =>
    !line.source_request_item_id || !expectedRequestItemIds.has(line.source_request_item_id))) {
    throw new Error("Existing purchase-order lines cannot be reconciled to the approved request items. Manual review is required.");
  }

  const lineMatches = (saved: any, line: (typeof orderLines)[number]) =>
    Boolean(saved) &&
    saved.inventory_item_id === line.inventoryItemId &&
    saved.supplier_product_id === line.supplierProductId &&
    saved.source_action_id === line.sourceActionId &&
    saved.unit_id === line.unitId &&
    saved.stock_unit_id === line.stockUnitId &&
    Number(saved.stock_units_per_purchase_unit ?? 0) === Number(line.stockUnitsPerPurchaseUnit ?? 0) &&
    Number(saved.minimum_order_quantity ?? 0) === Number(line.minimumOrderQuantity ?? 0) &&
    Number(saved.order_multiple ?? 0) === Number(line.orderMultiple ?? 0) &&
    Math.abs(Number(saved.quantity) - line.quantity) <= 0.0001 &&
    Math.abs(Number(saved.unit_price) - line.unitPrice) <= 0.0001;

  const missingLines = orderLines.filter((line) => {
    const saved = existingByRequestItem.get(line.requestItemId);
    if (!saved) return true;
    if (!lineMatches(saved, line)) {
      throw new Error("An existing purchase-order line differs from its approved request line. Manual reconciliation is required.");
    }
    return false;
  });
  if (missingLines.length > 0 && po.status !== "draft") {
    throw new Error("A non-draft purchase order is missing approved request lines. Manual recovery is required.");
  }

  if (missingLines.length > 0) {
    const { error: insertLinesError } = await sb.from("restaurant_purchase_order_items").insert(
      missingLines.map((line) => ({
        tenant_id: input.tenantId,
        purchase_order_id: po.id,
        purchase_request_id: input.requestId,
        source_request_item_id: line.requestItemId,
        source_action_id: line.sourceActionId,
        inventory_item_id: line.inventoryItemId,
        supplier_product_id: line.supplierProductId,
        unit_id: line.unitId,
        stock_unit_id: line.stockUnitId,
        stock_units_per_purchase_unit: line.stockUnitsPerPurchaseUnit,
        minimum_order_quantity: line.minimumOrderQuantity,
        order_multiple: line.orderMultiple,
        description: line.description,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        line_total: Number((line.quantity * line.unitPrice).toFixed(4)),
      })),
    );
    if (insertLinesError && String((insertLinesError as any).code) !== "23505") {
      throw new Error(insertLinesError.message);
    }
  }

  const { data: persistedLines, error: persistedLinesError } = await sb
    .from("restaurant_purchase_order_items")
    .select("id, source_request_item_id, source_action_id, inventory_item_id, supplier_product_id, unit_id, stock_unit_id, stock_units_per_purchase_unit, minimum_order_quantity, order_multiple, quantity, unit_price")
    .eq("tenant_id", input.tenantId)
    .eq("purchase_order_id", po.id);
  if (persistedLinesError) throw new Error("Unable to verify persisted purchase-order lines: " + persistedLinesError.message);
  const persistedByRequestItem = new Map(
    ((persistedLines ?? []) as any[]).map((line) => [line.source_request_item_id, line]),
  );
  if (persistedByRequestItem.size !== orderLines.length ||
      orderLines.some((line) => !lineMatches(persistedByRequestItem.get(line.requestItemId), line))) {
    throw new Error("Persisted purchase-order lines do not reconcile with approved purchase-request quantities and unit snapshots.");
  }

  for (const line of missingLines) {
    await recordPriceObservation(sb, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      inventoryItemId: line.inventoryItemId,
      unitId: line.unitId,
      priceType: "ordered",
      price: line.unitPrice,
      quantity: line.quantity,
      currency: req.currency,
      sourceType: "purchase_order",
      sourceId: po.id,
    });
  }

  if (req.status !== "converted_to_po") {
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
  }

  if (poCreated) {
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
  } else if (missingLines.length > 0) {
    await recordProcurementAudit(sb, userId, {
      tenantId: input.tenantId,
      documentType: "purchase_order",
      documentId: po.id,
      documentNumber: po.document_number,
      action: "recovered_missing_request_lines",
      newState: po.status,
      correlationId: req.correlation_id,
      metadata: { from_request: req.document_number, recovered_line_count: missingLines.length },
    });
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.order.created",
    tenantId: input.tenantId,
    propertyId: req.property_id ?? undefined,
    locationId: req.location_id ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    correlationId: req.correlation_id ?? undefined,
    dedupeKey: "restaurant.po." + po.id + ".created",
    payload: {
      document_number: po.document_number,
      total: Number(po.total ?? subtotal),
      from_request: req.document_number,
    },
  });

  return po;
}
