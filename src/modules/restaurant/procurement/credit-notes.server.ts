/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { nextDocumentNumber, recordProcurementAuditStrict } from "./audit.server";
import {
  DOCUMENT_PREFIX,
  type applySupplierCreditNoteSchema,
  type listSupplierCreditNotesSchema,
  type recordSupplierCreditNoteSchema,
} from "./contracts";

type Sb = any;

export async function recordSupplierCreditNote(
  sb: Sb,
  userId: string,
  input: z.infer<typeof recordSupplierCreditNoteSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");

  const { data: supplier, error: supplierError } = await sb
    .from("restaurant_suppliers")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.supplierId)
    .single();
  if (supplierError || !supplier) {
    throw new Error("Supplier is missing or inaccessible in this tenant.");
  }

  const subtotal = Number(input.subtotal.toFixed(2));
  const taxTotal = Number(input.taxTotal.toFixed(2));
  const total = Number((subtotal + taxTotal).toFixed(2));
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("A supplier credit note must have a positive net or tax amount.");
  }

  let linkedInvoiceScope: { property_id?: string | null; location_id?: string | null } = {};
  if (input.referenceInvoiceId) {
    const { data: invoice, error: invoiceError } = await sb
      .from("restaurant_supplier_invoices")
      .select("id, supplier_id, currency, property_id, location_id, status")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.referenceInvoiceId)
      .single();
    if (invoiceError || !invoice) {
      throw new Error("Referenced supplier invoice is missing or inaccessible.");
    }
    if (invoice.status === "cancelled") {
      throw new Error("A credit note cannot reference a cancelled supplier invoice.");
    }
    if (invoice.supplier_id !== input.supplierId) {
      throw new Error("Credit note supplier must match the referenced invoice supplier.");
    }
    if (String(invoice.currency ?? "").toUpperCase() !== input.currency.toUpperCase()) {
      throw new Error("Credit note currency must match the referenced invoice currency.");
    }
    if (input.propertyId && invoice.property_id && input.propertyId !== invoice.property_id) {
      throw new Error("Credit note property does not match the referenced invoice.");
    }
    if (input.locationId && invoice.location_id && input.locationId !== invoice.location_id) {
      throw new Error("Credit note location does not match the referenced invoice.");
    }
    linkedInvoiceScope = {
      property_id: invoice.property_id ?? null,
      location_id: invoice.location_id ?? null,
    };
  }

  const documentNumber = await nextDocumentNumber(
    sb,
    input.tenantId,
    "supplier_credit_note",
    DOCUMENT_PREFIX.supplier_credit_note,
  );
  const { data, error } = await sb
    .from("restaurant_supplier_credit_notes")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? linkedInvoiceScope.property_id ?? null,
      location_id: input.locationId ?? linkedInvoiceScope.location_id ?? null,
      supplier_id: input.supplierId,
      reference_invoice_id: input.referenceInvoiceId ?? null,
      document_number: documentNumber,
      supplier_credit_note_number: input.supplierCreditNoteNumber.trim(),
      credit_date: input.creditDate,
      currency: input.currency.toUpperCase(),
      subtotal,
      tax_total: taxTotal,
      total,
      reason: input.reason.trim(),
      notes: input.notes ?? null,
      status: "recorded",
      recorded_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await recordProcurementAuditStrict(sb, userId, {
    tenantId: input.tenantId,
    documentType: "supplier_credit_note",
    documentId: data.id,
    documentNumber: data.document_number,
    action: "recorded",
    newState: "recorded",
    reason: input.reason,
    metadata: {
      supplier_id: input.supplierId,
      reference_invoice_id: input.referenceInvoiceId ?? null,
      subtotal,
      tax_total: taxTotal,
      total,
      currency: input.currency.toUpperCase(),
    },
  });

  return data;
}

export async function listSupplierCreditNotes(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listSupplierCreditNotesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_supplier_credit_notes")
    .select(
      "id, tenant_id, property_id, location_id, supplier_id, reference_invoice_id, document_number, supplier_credit_note_number, credit_date, currency, subtotal, tax_total, total, reason, status, created_at, restaurant_suppliers(name), restaurant_supplier_credit_note_applications(amount)",
    )
    .eq("tenant_id", input.tenantId)
    .order("credit_date", { ascending: false })
    .limit(input.limit);
  if (input.supplierId) q = q.eq("supplier_id", input.supplierId);
  if (input.status) q = q.eq("status", input.status);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map((note) => {
    const applied = (note.restaurant_supplier_credit_note_applications ?? []).reduce(
      (sum: number, application: any) => sum + Number(application.amount ?? 0),
      0,
    );
    return {
      ...note,
      supplier_name: note.restaurant_suppliers?.name ?? null,
      applied_amount: Number(applied.toFixed(2)),
      remaining_amount: Number((Number(note.total) - applied).toFixed(2)),
    };
  });
}

export async function applySupplierCreditNote(
  sb: Sb,
  userId: string,
  input: z.infer<typeof applySupplierCreditNoteSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "invoice.manage");
  const { data, error } = await sb.rpc("restaurant_apply_supplier_credit_note", {
    _tenant_id: input.tenantId,
    _credit_note_id: input.creditNoteId,
    _invoice_id: input.invoiceId,
    _amount: input.amount,
    _reason: input.reason.trim(),
    _idempotency_key: input.idempotencyKey,
  });
  if (error) throw new Error(error.message);
  return data;
}
