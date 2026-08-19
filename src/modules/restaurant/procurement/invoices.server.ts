/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Supplier invoices and three-way matching.
 *
 * Match = purchase order (what we agreed to buy)
 *       + goods receipt (what we accepted)
 *       + invoice        (what we are being billed for)
 *
 * The system reports the match; it never silently approves a mismatch.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { nextDocumentNumber, recordProcurementAudit } from "./audit.server";
import { recordPriceObservation } from "./pricing.server";
import { raiseVariance } from "./variances.server";
import {
  DOCUMENT_PREFIX,
  type RecordInvoiceInput,
  type listInvoicesSchema,
  type setInvoicePaymentStatusSchema,
} from "./contracts";

type Sb = any;

const INVOICE_SELECT =
  "id, document_number, supplier_invoice_number, supplier_id, purchase_order_id, status, payment_status, match_status, matched_at, invoice_date, due_date, currency, subtotal, tax_total, total, amount_paid, attachment_url, notes, created_at";

export async function listSupplierInvoices(sb: Sb, userId: string, input: z.infer<typeof listInvoicesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_supplier_invoices")
    .select(INVOICE_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("invoice_date", { ascending: false })
    .limit(input.limit);
  if (input.supplierId) q = q.eq("supplier_id", input.supplierId);
  if (input.status) q = q.eq("status", input.status);
  if (input.paymentStatus) q = q.eq("payment_status", input.paymentStatus);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const { data: suppliers } = await sb
    .from("restaurant_suppliers")
    .select("id, name")
    .eq("tenant_id", input.tenantId);
  const names = new Map(((suppliers ?? []) as any[]).map((s) => [s.id, s.name]));
  return ((data ?? []) as any[]).map((i) => ({ ...i, supplier_name: names.get(i.supplier_id) ?? "—" }));
}

export async function recordSupplierInvoice(sb: Sb, userId: string, input: RecordInvoiceInput) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");

  const subtotal = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const taxTotal = input.taxTotal || input.lines.reduce((s, l) => s + (l.taxAmount ?? 0), 0);
  const total = subtotal + taxTotal;

  const documentNumber = await nextDocumentNumber(
    sb,
    input.tenantId,
    "supplier_invoice",
    DOCUMENT_PREFIX.supplier_invoice,
  );

  const { data: invoice, error } = await sb
    .from("restaurant_supplier_invoices")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      supplier_id: input.supplierId,
      purchase_order_id: input.purchaseOrderId ?? null,
      document_number: documentNumber,
      supplier_invoice_number: input.supplierInvoiceNumber,
      status: "recorded",
      payment_status: "unpaid",
      match_status: "unmatched",
      invoice_date: input.invoiceDate,
      due_date: input.dueDate ?? null,
      currency: input.currency,
      subtotal,
      tax_total: taxTotal,
      total,
      amount_paid: 0,
      attachment_url: input.attachmentUrl ?? null,
      notes: input.notes ?? null,
      recorded_by: userId,
    })
    .select("id, document_number, total")
    .single();
  if (error) {
    if (String(error.code) === "23505") {
      throw new Error("This supplier invoice number has already been recorded for this supplier.");
    }
    throw new Error(error.message);
  }

  if (input.lines.length > 0) {
    const { error: lErr } = await sb.from("restaurant_supplier_invoice_items").insert(
      input.lines.map((l) => ({
        tenant_id: input.tenantId,
        invoice_id: invoice.id,
        purchase_order_item_id: l.purchaseOrderItemId ?? null,
        receipt_item_id: l.receiptItemId ?? null,
        inventory_item_id: l.inventoryItemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        tax_amount: l.taxAmount ?? 0,
        line_total: l.quantity * l.unitPrice + (l.taxAmount ?? 0),
      })),
    );
    if (lErr) throw new Error(lErr.message);

    for (const l of input.lines) {
      await recordPriceObservation(sb, {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        inventoryItemId: l.inventoryItemId ?? null,
        priceType: "invoiced",
        price: l.unitPrice,
        quantity: l.quantity,
        currency: input.currency,
        effectiveDate: input.invoiceDate,
        sourceType: "supplier_invoice",
        sourceId: invoice.id,
        dedupeSuffix: l.description,
      });
    }
  }

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "supplier_invoice",
    documentId: invoice.id,
    documentNumber,
    action: "created",
    newState: "recorded",
    metadata: { supplier_invoice_number: input.supplierInvoiceNumber, total },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.invoice.recorded",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_supplier_invoice",
    entityId: invoice.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.invoice.${invoice.id}.recorded`,
    payload: { document_number: documentNumber, total, supplier_id: input.supplierId },
  });

  const match = await matchSupplierInvoice(sb, userId, input.tenantId, invoice.id);
  return { id: invoice.id, documentNumber, total, match };
}

/** Three-way match: order vs accepted receipts vs invoice. Reports, never approves. */
export async function matchSupplierInvoice(sb: Sb, userId: string, tenantId: string, invoiceId: string) {
  await assertCapability(sb, userId, tenantId, "invoice.manage");

  const { data: invoice, error } = await sb
    .from("restaurant_supplier_invoices")
    .select(
      "id, tenant_id, supplier_id, purchase_order_id, document_number, total, currency, property_id, location_id",
    )
    .eq("tenant_id", tenantId)
    .eq("id", invoiceId)
    .single();
  if (error || !invoice) throw new Error("Supplier invoice not found.");

  const invoiceTotal = Number(invoice.total ?? 0);
  let orderTotal: number | null = null;
  let receivedValue: number | null = null;
  const dimensions: Array<{ dimension: "quantity" | "price"; label: string; expected: number; actual: number }> = [];

  if (invoice.purchase_order_id) {
    const { data: po } = await sb
      .from("restaurant_purchase_orders")
      .select("id, total")
      .eq("tenant_id", tenantId)
      .eq("id", invoice.purchase_order_id)
      .single();
    orderTotal = po ? Number(po.total ?? 0) : null;

    const { data: receipts } = await sb
      .from("restaurant_goods_receipts")
      .select("id, accepted_value, status")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", invoice.purchase_order_id)
      .eq("status", "posted");
    receivedValue = ((receipts ?? []) as any[]).reduce((s, r) => s + Number(r.accepted_value ?? 0), 0);

    // ---- line-level match: quantity and price are separate dimensions -----
    const [{ data: invoiceLines }, { data: orderLines }, { data: receiptLines }] = await Promise.all([
      sb
        .from("restaurant_supplier_invoice_items")
        .select("id, purchase_order_item_id, description, quantity, unit_price")
        .eq("tenant_id", tenantId)
        .eq("invoice_id", invoice.id),
      sb
        .from("restaurant_purchase_order_items")
        .select("id, description, quantity, unit_price")
        .eq("tenant_id", tenantId)
        .eq("purchase_order_id", invoice.purchase_order_id),
      ((receipts ?? []) as any[]).length
        ? sb
            .from("restaurant_goods_receipt_items")
            .select("purchase_order_item_id, accepted_quantity")
            .eq("tenant_id", tenantId)
            .in(
              "receipt_id",
              ((receipts ?? []) as any[]).map((r) => r.id),
            )
        : Promise.resolve({ data: [] }),
    ]);

    const orderById = new Map(((orderLines ?? []) as any[]).map((o) => [o.id, o]));
    const acceptedByOrderItem = new Map<string, number>();
    for (const r of (receiptLines ?? []) as any[]) {
      if (!r.purchase_order_item_id) continue;
      acceptedByOrderItem.set(
        r.purchase_order_item_id,
        (acceptedByOrderItem.get(r.purchase_order_item_id) ?? 0) + Number(r.accepted_quantity ?? 0),
      );
    }

    for (const line of (invoiceLines ?? []) as any[]) {
      if (!line.purchase_order_item_id) continue;
      const order = orderById.get(line.purchase_order_item_id);
      if (!order) continue;
      const invoicedQty = Number(line.quantity ?? 0);
      const invoicedPrice = Number(line.unit_price ?? 0);
      const acceptedQty = acceptedByOrderItem.get(line.purchase_order_item_id) ?? 0;
      const orderedPrice = Number(order.unit_price ?? 0);

      if (Math.abs(invoicedQty - acceptedQty) > 0.0001) {
        dimensions.push({
          dimension: "quantity",
          label: `${line.description}: invoiced ${invoicedQty} against ${acceptedQty} accepted`,
          expected: acceptedQty,
          actual: invoicedQty,
        });
      }
      if (orderedPrice > 0 && Math.abs(invoicedPrice - orderedPrice) > 0.0001) {
        dimensions.push({
          dimension: "price",
          label: `${line.description}: invoiced at ${invoicedPrice} against ${orderedPrice} ordered`,
          expected: orderedPrice,
          actual: invoicedPrice,
        });
      }
    }

    for (const d of dimensions) {
      await raiseVariance(sb, userId, {
        tenantId,
        propertyId: invoice.property_id,
        locationId: invoice.location_id,
        varianceType: d.dimension,
        severity: "high",
        label: d.label,
        purchaseOrderId: invoice.purchase_order_id,
        invoiceId: invoice.id,
        supplierId: invoice.supplier_id,
        expectedValue: d.expected,
        actualValue: d.actual,
        currency: invoice.currency,
        detail: { stage: "three_way_match", dimension: d.dimension },
        dedupeKey: `invoice-${d.dimension}:${invoice.id}:${d.label}`,
      });
    }
  }

  const tolerance = 0.01; // 1% commercial tolerance
  const within = (a: number | null, b: number) =>
    a == null ? null : Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * tolerance + 0.5;

  const orderOk = within(orderTotal, invoiceTotal);
  const receiptOk = within(receivedValue, invoiceTotal);

  let matchStatus: "unmatched" | "matched" | "partially_matched" | "mismatched";
  if (orderTotal == null && receivedValue == null) matchStatus = "unmatched";
  else if (dimensions.length > 0) matchStatus = "mismatched";
  else if (orderOk !== false && receiptOk !== false) matchStatus = "matched";
  else if (orderOk === true || receiptOk === true) matchStatus = "partially_matched";
  else matchStatus = "mismatched";

  if (receivedValue != null && receiptOk === false) {
    await raiseVariance(sb, userId, {
      tenantId,
      propertyId: invoice.property_id,
      locationId: invoice.location_id,
      varianceType: "invoice",
      severity: "high",
      label: `Invoice ${invoice.document_number} does not match accepted goods value`,
      purchaseOrderId: invoice.purchase_order_id,
      invoiceId: invoice.id,
      supplierId: invoice.supplier_id,
      expectedValue: receivedValue,
      actualValue: invoiceTotal,
      currency: invoice.currency,
      detail: { stage: "three_way_match", order_total: orderTotal },
      dedupeKey: `invoice-match:${invoice.id}`,
    });
  }

  await sb
    .from("restaurant_supplier_invoices")
    .update({
      match_status: matchStatus,
      matched_at: new Date().toISOString(),
      status: matchStatus === "mismatched" ? "disputed" : matchStatus === "matched" ? "matched" : "recorded",
    })
    .eq("tenant_id", tenantId)
    .eq("id", invoice.id);

  await recordProcurementAudit(sb, userId, {
    tenantId,
    documentType: "supplier_invoice",
    documentId: invoice.id,
    documentNumber: invoice.document_number,
    action: "matched",
    newState: matchStatus,
    metadata: { order_total: orderTotal, received_value: receivedValue, invoice_total: invoiceTotal },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.invoice.matched",
    tenantId,
    propertyId: invoice.property_id ?? undefined,
    locationId: invoice.location_id ?? undefined,
    entityType: "restaurant_supplier_invoice",
    entityId: invoice.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.invoice.${invoice.id}.${matchStatus}`,
    payload: {
      match_status: matchStatus,
      order_total: orderTotal,
      received_value: receivedValue,
      invoice_total: invoiceTotal,
      variance_dimensions: dimensions.map((d) => d.dimension),
    },
  });

  return { matchStatus, orderTotal, receivedValue, invoiceTotal, dimensions };
}

export async function setInvoicePaymentStatus(
  sb: Sb,
  userId: string,
  input: z.infer<typeof setInvoicePaymentStatusSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");
  const { data: before } = await sb
    .from("restaurant_supplier_invoices")
    .select("id, payment_status, document_number, total, match_status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.invoiceId)
    .single();
  if (!before) throw new Error("Supplier invoice not found.");
  // Settlement is separate from matching: paying an invoice never resolves a
  // procurement variance, and an unmatched invoice is never quietly settled.
  const settling = input.paymentStatus === "paid" || input.paymentStatus === "partially_paid";
  if (settling && before.match_status !== "matched" && !input.reason) {
    throw new Error(
      `This invoice is "${before.match_status ?? "unmatched"}" — an authorised written reason is required before it can be settled.`,
    );
  }
  if (settling && before.match_status !== "matched") {
    await assertCapability(sb, userId, input.tenantId, "variance.manage");
  }

  const { data, error } = await sb
    .from("restaurant_supplier_invoices")
    .update({
      payment_status: input.paymentStatus,
      amount_paid:
        input.amountPaid ?? (input.paymentStatus === "paid" ? Number(before.total ?? 0) : undefined),
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.invoiceId)
    .select("id, payment_status, amount_paid")
    .single();
  if (error) throw new Error(error.message);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "supplier_invoice",
    documentId: input.invoiceId,
    documentNumber: before.document_number,
    action: "payment_status_changed",
    previousState: before.payment_status,
    newState: input.paymentStatus,
    reason: input.reason ?? null,
    metadata: { amount_paid: data.amount_paid },
  });
  return data;
}
