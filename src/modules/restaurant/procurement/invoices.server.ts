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
import { assertCapability, assertTenantRead, getTenantScope } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { nextDocumentNumber, recordProcurementAuditStrict } from "./audit.server";
import { recordPriceObservation } from "./pricing.server";
import { raiseVariance } from "./variances.server";
import { calculateSupplierInvoiceMatch } from "./invoice-matching";
import {
  DOCUMENT_PREFIX,
  type RecordInvoiceInput,
  type listInvoicesSchema,
  type setInvoicePaymentStatusSchema,
} from "./contracts";

type Sb = any;

const INVOICE_SELECT =
  "id, document_number, supplier_invoice_number, supplier_id, purchase_order_id, status, payment_status, match_status, matched_at, invoice_date, due_date, currency, subtotal, tax_total, total, amount_paid, attachment_url, notes, created_at";

export async function listSupplierInvoices(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listInvoicesSchema>,
) {
  const tenantScope = await getTenantScope(sb, userId, input.tenantId);
  await assertTenantRead(
    sb,
    userId,
    input.tenantId,
    {
      propertyId: input.propertyId,
      locationId: input.locationId,
    },
    tenantScope,
  );
  let q = sb
    .from("restaurant_supplier_invoices")
    .select(INVOICE_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("invoice_date", { ascending: false })
    .limit(input.limit);
  if (input.supplierId) q = q.eq("supplier_id", input.supplierId);
  if (input.propertyId) {
    q = q.eq("property_id", input.propertyId);
  } else if (
    !tenantScope.platformAdmin &&
    !tenantScope.grants.some((grant) => grant.propertyId === null)
  ) {
    const propertyIds = [
      ...new Set(tenantScope.grants.map((grant) => grant.propertyId).filter(Boolean)),
    ] as string[];
    if (propertyIds.length === 0) return [];
    q = q.in("property_id", propertyIds);
  }
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.status) q = q.eq("status", input.status);
  if (input.paymentStatus) q = q.eq("payment_status", input.paymentStatus);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const invoiceRows = (data ?? []) as any[];
  const invoiceIds = invoiceRows.map((invoice) => invoice.id);
  let applications: any[] = [];
  if (invoiceIds.length > 0) {
    const { data: rows, error: applicationsError } = await sb
      .from("restaurant_supplier_credit_note_applications")
      .select("invoice_id, amount")
      .eq("tenant_id", input.tenantId)
      .in("invoice_id", invoiceIds);
    if (applicationsError) {
      throw new Error("Unable to load supplier credit applications: " + applicationsError.message);
    }
    applications = (rows ?? []) as any[];
  }
  const creditByInvoice = new Map<string, number>();
  for (const application of applications) {
    creditByInvoice.set(
      application.invoice_id,
      (creditByInvoice.get(application.invoice_id) ?? 0) + Number(application.amount ?? 0),
    );
  }

  const { data: suppliers, error: suppliersError } = await sb
    .from("restaurant_suppliers")
    .select("id, name")
    .eq("tenant_id", input.tenantId);
  if (suppliersError)
    throw new Error("Unable to load invoice suppliers: " + suppliersError.message);
  const names = new Map(
    ((suppliers ?? []) as any[]).map((supplier) => [supplier.id, supplier.name]),
  );
  return invoiceRows.map((invoice) => {
    const creditApplied = creditByInvoice.get(invoice.id) ?? 0;
    return {
      ...invoice,
      supplier_name: names.get(invoice.supplier_id) ?? "—",
      credit_applied: Number(creditApplied.toFixed(2)),
      outstanding_balance: Number(
        Math.max(
          0,
          Number(invoice.total ?? 0) - Number(invoice.amount_paid ?? 0) - creditApplied,
        ).toFixed(2),
      ),
    };
  });
}

export async function recordSupplierInvoice(sb: Sb, userId: string, input: RecordInvoiceInput) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");

  let linkedOrderScope: { property_id?: string | null; location_id?: string | null } = {};
  const { data: supplier, error: supplierError } = await sb
    .from("restaurant_suppliers")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.supplierId)
    .single();
  if (supplierError || !supplier)
    throw new Error("Supplier is missing or inaccessible in this tenant.");

  if (input.purchaseOrderId) {
    const { data: linkedOrder, error: orderError } = await sb
      .from("restaurant_purchase_orders")
      .select("id, supplier_id, currency, property_id, location_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.purchaseOrderId)
      .single();
    if (orderError || !linkedOrder)
      throw new Error("Linked purchase order is missing or inaccessible.");
    if (linkedOrder.supplier_id !== input.supplierId) {
      throw new Error("Supplier invoice must belong to the same supplier as its purchase order.");
    }
    if (String(linkedOrder.currency ?? "").toUpperCase() !== input.currency.toUpperCase()) {
      throw new Error(
        "Supplier invoice currency must match its purchase order currency; FX conversion is not inferred.",
      );
    }
    if (
      input.propertyId &&
      linkedOrder.property_id &&
      input.propertyId !== linkedOrder.property_id
    ) {
      throw new Error("Supplier invoice property does not match the linked purchase order.");
    }
    if (
      input.locationId &&
      linkedOrder.location_id &&
      input.locationId !== linkedOrder.location_id
    ) {
      throw new Error("Supplier invoice location does not match the linked purchase order.");
    }
    linkedOrderScope = {
      property_id: linkedOrder.property_id ?? null,
      location_id: linkedOrder.location_id ?? null,
    };
  }

  await assertCapability(sb, userId, input.tenantId, "invoice.manage", {
    propertyId: input.propertyId ?? linkedOrderScope.property_id ?? null,
    locationId: input.locationId ?? linkedOrderScope.location_id ?? null,
  });

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
      property_id: input.propertyId ?? linkedOrderScope.property_id ?? null,
      location_id: input.locationId ?? linkedOrderScope.location_id ?? null,
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

  await recordProcurementAuditStrict(sb, userId, {
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
    propertyId: input.propertyId ?? linkedOrderScope.property_id ?? undefined,
    locationId: input.locationId ?? linkedOrderScope.location_id ?? undefined,
    entityType: "restaurant_supplier_invoice",
    entityId: invoice.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.invoice.${invoice.id}.recorded`,
    payload: { document_number: documentNumber, total, supplier_id: input.supplierId },
  });

  const match = await matchSupplierInvoice(sb, userId, input.tenantId, invoice.id);
  return { id: invoice.id, documentNumber, total, match };
}

/** Three-way match using only tenant-scoped, posted and currency-consistent evidence. */
export async function matchSupplierInvoice(
  sb: Sb,
  userId: string,
  tenantId: string,
  invoiceId: string,
) {
  await assertCapability(sb, userId, tenantId, "invoice.manage");

  const { data: invoice, error: invoiceError } = await sb
    .from("restaurant_supplier_invoices")
    .select(
      "id, tenant_id, supplier_id, purchase_order_id, document_number, subtotal, tax_total, total, currency, property_id, location_id, recorded_by",
    )
    .eq("tenant_id", tenantId)
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error("Supplier invoice not found.");
  await assertCapability(sb, userId, tenantId, "invoice.manage", {
    propertyId: invoice.property_id ?? null,
    locationId: invoice.location_id ?? null,
  });
  // P0-04 separation of duties: the recorder of an invoice cannot match it.
  if (invoice.recorded_by === userId) {
    throw new Error(
      "Separation of duties — the user who recorded this supplier invoice cannot reconcile it.",
    );
  }

  const { data: invoiceLines, error: invoiceLinesError } = await sb
    .from("restaurant_supplier_invoice_items")
    .select(
      "id, purchase_order_item_id, receipt_item_id, description, quantity, unit_price, tax_amount",
    )
    .eq("tenant_id", tenantId)
    .eq("invoice_id", invoice.id);
  if (invoiceLinesError)
    throw new Error("Unable to load supplier invoice lines: " + invoiceLinesError.message);

  let purchaseOrder: { currency: string; lines: any[] } | null = null;
  let orderTotal: number | null = null;
  let receivedValue: number | null = null;
  let receiptCurrencies: string[] = [];
  let receiptEvidence: any[] = [];
  const previouslyInvoicedQuantities: Record<string, number> = {};

  if (invoice.purchase_order_id) {
    const { data: po, error: poError } = await sb
      .from("restaurant_purchase_orders")
      .select("id, supplier_id, total, currency")
      .eq("tenant_id", tenantId)
      .eq("id", invoice.purchase_order_id)
      .single();
    if (poError || !po) throw new Error("Linked purchase order is missing or inaccessible.");
    if (po.supplier_id !== invoice.supplier_id) {
      throw new Error("Supplier invoice and linked purchase order belong to different suppliers.");
    }
    orderTotal = Number(po.total ?? 0);

    const { data: receipts, error: receiptsError } = await sb
      .from("restaurant_goods_receipts")
      .select("id, accepted_value, status, currency")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", invoice.purchase_order_id)
      .eq("status", "posted");
    if (receiptsError)
      throw new Error("Unable to load posted receipt evidence: " + receiptsError.message);
    const postedReceipts = (receipts ?? []) as any[];
    receivedValue = postedReceipts.reduce((sum, row) => sum + Number(row.accepted_value ?? 0), 0);
    receiptCurrencies = postedReceipts.map((row) => String(row.currency ?? po.currency ?? ""));

    const { data: orderLines, error: orderLinesError } = await sb
      .from("restaurant_purchase_order_items")
      .select("id, description, quantity, unit_price")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", invoice.purchase_order_id);
    if (orderLinesError)
      throw new Error("Unable to load purchase-order lines: " + orderLinesError.message);

    const { data: priorInvoices, error: priorInvoicesError } = await sb
      .from("restaurant_supplier_invoices")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("purchase_order_id", invoice.purchase_order_id)
      .neq("id", invoice.id)
      .neq("status", "cancelled");
    if (priorInvoicesError)
      throw new Error("Unable to load prior invoice evidence: " + priorInvoicesError.message);
    const priorInvoiceIds = ((priorInvoices ?? []) as any[]).map((row) => row.id);
    if (priorInvoiceIds.length > 0) {
      const { data: priorLines, error: priorLinesError } = await sb
        .from("restaurant_supplier_invoice_items")
        .select("purchase_order_item_id, quantity")
        .eq("tenant_id", tenantId)
        .in("invoice_id", priorInvoiceIds);
      if (priorLinesError)
        throw new Error("Unable to load prior invoiced quantities: " + priorLinesError.message);
      for (const line of (priorLines ?? []) as any[]) {
        if (!line.purchase_order_item_id) continue;
        const quantity = Number(line.quantity ?? 0);
        if (!Number.isFinite(quantity) || quantity < 0) {
          throw new Error("Prior supplier invoice contains an invalid line quantity.");
        }
        previouslyInvoicedQuantities[line.purchase_order_item_id] =
          (previouslyInvoicedQuantities[line.purchase_order_item_id] ?? 0) + quantity;
      }
    }

    let receiptLines: any[] = [];
    if (postedReceipts.length > 0) {
      const { data, error } = await sb
        .from("restaurant_goods_receipt_items")
        .select("id, receipt_id, purchase_order_item_id, accepted_quantity")
        .eq("tenant_id", tenantId)
        .in(
          "receipt_id",
          postedReceipts.map((row) => row.id),
        );
      if (error) throw new Error("Unable to load accepted receipt lines: " + error.message);
      receiptLines = (data ?? []) as any[];
    }
    const postedIds = new Set(postedReceipts.map((row) => row.id));
    receiptEvidence = receiptLines.map((line) => ({
      id: line.id,
      purchaseOrderItemId: line.purchase_order_item_id ?? null,
      acceptedQuantity: Number(line.accepted_quantity ?? 0),
      posted: postedIds.has(line.receipt_id),
    }));
    purchaseOrder = {
      currency: String(po.currency ?? ""),
      lines: ((orderLines ?? []) as any[]).map((line) => ({
        id: line.id,
        quantity: Number(line.quantity ?? 0),
        unitPrice: Number(line.unit_price ?? 0),
      })),
    };
  }

  const result = calculateSupplierInvoiceMatch({
    invoice: {
      currency: String(invoice.currency ?? ""),
      subtotal: Number(invoice.subtotal ?? 0),
      taxTotal: Number(invoice.tax_total ?? 0),
      total: Number(invoice.total ?? 0),
    },
    purchaseOrder,
    receipts: receiptEvidence,
    receiptCurrencies,
    previouslyInvoicedQuantities,
    invoiceLines: ((invoiceLines ?? []) as any[]).map((line) => ({
      id: line.id,
      purchaseOrderItemId: line.purchase_order_item_id ?? null,
      receiptItemId: line.receipt_item_id ?? null,
      description: String(line.description ?? "Invoice line"),
      quantity: Number(line.quantity ?? 0),
      unitPrice: Number(line.unit_price ?? 0),
      taxAmount: Number(line.tax_amount ?? 0),
    })),
  });

  for (const dimension of result.dimensions) {
    await raiseVariance(sb, userId, {
      tenantId,
      propertyId: invoice.property_id,
      locationId: invoice.location_id,
      varianceType: dimension.dimension,
      severity: "high",
      label: dimension.label,
      purchaseOrderId: invoice.purchase_order_id,
      invoiceId: invoice.id,
      supplierId: invoice.supplier_id,
      expectedValue: dimension.expected,
      actualValue: dimension.actual,
      currency: invoice.currency,
      detail: {
        stage: "pw08_three_way_match",
        code: dimension.code,
        dimension: dimension.dimension,
      },
      dedupeKey: `pw08:${dimension.code}:${invoice.id}`,
    });
  }

  const { error: updateError } = await sb
    .from("restaurant_supplier_invoices")
    .update({
      match_status: result.matchStatus,
      matched_at: new Date().toISOString(),
      status:
        result.matchStatus === "mismatched"
          ? "disputed"
          : result.matchStatus === "matched"
            ? "matched"
            : "recorded",
    })
    .eq("tenant_id", tenantId)
    .eq("id", invoice.id);
  if (updateError)
    throw new Error("Unable to persist invoice match result: " + updateError.message);

  await recordProcurementAuditStrict(sb, userId, {
    tenantId,
    documentType: "supplier_invoice",
    documentId: invoice.id,
    documentNumber: invoice.document_number,
    action: "matched",
    newState: result.matchStatus,
    metadata: {
      order_total: orderTotal,
      accepted_receipt_value: receivedValue,
      invoice_subtotal: result.netSubtotal,
      invoice_tax: result.taxTotal,
      invoice_total: result.grossTotal,
      variance_codes: result.dimensions.map((dimension) => dimension.code),
      accepted_line_count: result.acceptedLineCount,
      pending_line_count: result.pendingLineCount,
    },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.invoice.matched",
    tenantId,
    propertyId: invoice.property_id ?? undefined,
    locationId: invoice.location_id ?? undefined,
    entityType: "restaurant_supplier_invoice",
    entityId: invoice.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.invoice.${invoice.id}.${result.matchStatus}`,
    payload: {
      match_status: result.matchStatus,
      order_total: orderTotal,
      accepted_receipt_value: receivedValue,
      invoice_subtotal: result.netSubtotal,
      invoice_tax: result.taxTotal,
      invoice_total: result.grossTotal,
      variance_codes: result.dimensions.map((dimension) => dimension.code),
    },
  });

  return {
    matchStatus: result.matchStatus,
    orderTotal,
    receivedValue,
    invoiceTotal: result.grossTotal,
    invoiceSubtotal: result.netSubtotal,
    taxTotal: result.taxTotal,
    dimensions: result.dimensions,
  };
}

export async function setInvoicePaymentStatus(
  sb: Sb,
  userId: string,
  input: z.infer<typeof setInvoicePaymentStatusSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");
  const { data: before, error: readError } = await sb
    .from("restaurant_supplier_invoices")
    .select(
      "id, payment_status, document_number, total, amount_paid, match_status, property_id, location_id, recorded_by",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.invoiceId)
    .single();
  if (readError || !before) throw new Error("Supplier invoice not found.");
  await assertCapability(sb, userId, input.tenantId, "invoice.manage", {
    propertyId: before.property_id ?? null,
    locationId: before.location_id ?? null,
  });

  const total = Number(before.total ?? 0);
  const previousAmountPaid = Number(before.amount_paid ?? 0);
  if (
    !Number.isFinite(total) ||
    total < 0 ||
    !Number.isFinite(previousAmountPaid) ||
    previousAmountPaid < 0
  ) {
    throw new Error("Invoice balance data is invalid; payment status cannot be changed.");
  }
  const { data: creditApplications, error: creditApplicationsError } = await sb
    .from("restaurant_supplier_credit_note_applications")
    .select("amount")
    .eq("tenant_id", input.tenantId)
    .eq("invoice_id", input.invoiceId);
  if (creditApplicationsError) {
    throw new Error("Unable to load applied supplier credits: " + creditApplicationsError.message);
  }
  const creditApplied = ((creditApplications ?? []) as any[]).reduce(
    (sum, application) => sum + Number(application.amount ?? 0),
    0,
  );
  if (!Number.isFinite(creditApplied) || creditApplied < 0 || creditApplied - total > 0.0001) {
    throw new Error("Applied supplier credit data is invalid; payment status cannot be changed.");
  }
  const payableTotal = Number((total - creditApplied).toFixed(2));

  // Settlement is a financial decision separate from both recording and matching.
  const settling = input.paymentStatus === "paid" || input.paymentStatus === "partially_paid";
  if (settling && before.recorded_by === userId) {
    throw new Error("Separation of duties — the invoice recorder cannot settle the same invoice.");
  }
  if (settling && before.match_status !== "matched" && !input.reason?.trim()) {
    throw new Error(
      `This invoice is "${before.match_status ?? "unmatched"}" — an authorised written reason is required before it can be settled.`,
    );
  }
  if (settling && before.match_status !== "matched") {
    await assertCapability(sb, userId, input.tenantId, "variance.manage");
  }

  const amountPaid =
    input.amountPaid ?? (input.paymentStatus === "paid" ? payableTotal : previousAmountPaid);
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw new Error("Amount paid must be a finite, non-negative value.");
  }
  if (amountPaid + 0.0001 < previousAmountPaid) {
    throw new Error(
      "Recorded payments cannot be reversed through invoice status; use a separately authorised refund or credit workflow.",
    );
  }
  if (amountPaid - payableTotal > 0.0001) {
    throw new Error(
      "Amount paid cannot exceed the outstanding invoice balance after supplier credits.",
    );
  }
  if (input.paymentStatus === "unpaid" && amountPaid + creditApplied > 0.0001) {
    throw new Error(
      "An invoice with a recorded payment or applied supplier credit cannot be marked unpaid.",
    );
  }
  if (
    input.paymentStatus === "partially_paid" &&
    !(amountPaid + creditApplied > 0.0001 && amountPaid + creditApplied < total - 0.0001)
  ) {
    throw new Error(
      "Partially paid status requires settlement by cash or supplier credit below the invoice total.",
    );
  }
  if (input.paymentStatus === "paid" && Math.abs(amountPaid + creditApplied - total) > 0.01) {
    throw new Error(
      "Paid status requires cash payments plus applied supplier credits to equal the invoice total.",
    );
  }
  if (
    input.paymentStatus === "disputed" &&
    input.amountPaid != null &&
    amountPaid !== previousAmountPaid
  ) {
    throw new Error("Dispute status cannot alter the recorded payment amount.");
  }

  const { data, error } = await sb
    .from("restaurant_supplier_invoices")
    .update({
      payment_status: input.paymentStatus,
      amount_paid: amountPaid,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.invoiceId)
    .eq("amount_paid", previousAmountPaid)
    .eq("payment_status", before.payment_status)
    .select("id, payment_status, amount_paid")
    .single();
  if (error) throw new Error(error.message);

  await recordProcurementAuditStrict(sb, userId, {
    tenantId: input.tenantId,
    documentType: "supplier_invoice",
    documentId: input.invoiceId,
    documentNumber: before.document_number,
    action: "payment_status_changed",
    previousState: before.payment_status,
    newState: input.paymentStatus,
    reason: input.reason ?? null,
    metadata: {
      previous_amount_paid: previousAmountPaid,
      amount_paid: data.amount_paid,
      invoice_total: total,
      credit_applied: creditApplied,
      outstanding_balance: Number((payableTotal - Number(data.amount_paid ?? 0)).toFixed(2)),
    },
  });
  return data;
}
