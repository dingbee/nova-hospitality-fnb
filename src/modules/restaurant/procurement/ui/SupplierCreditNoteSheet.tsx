/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  EntitySheet,
  Field,
  FieldRow,
  QuantityField,
  SearchSelect,
} from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  listRestaurantSupplierInvoicesFn,
  listRestaurantSuppliersFn,
  recordRestaurantSupplierCreditNoteFn,
  applyRestaurantSupplierCreditNoteFn,
  listRestaurantSupplierCreditNotesFn,
} from "../procurement.functions";
import { formatMoney } from "../lifecycle";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
}

export function SupplierCreditNoteSheet({ open, onOpenChange, tenantId }: SheetProps) {
  const qc = useQueryClient();
  const suppliersFn = useServerFn(listRestaurantSuppliersFn);
  const invoicesFn = useServerFn(listRestaurantSupplierInvoicesFn);
  const recordFn = useServerFn(recordRestaurantSupplierCreditNoteFn);

  const suppliers = useQuery({
    queryKey: ["restaurant.suppliers", tenantId],
    queryFn: () => suppliersFn({ data: { tenantId, limit: 200 } }),
    enabled: open,
  });
  const invoices = useQuery({
    queryKey: ["restaurant.procurement.invoices", tenantId],
    queryFn: () => invoicesFn({ data: { tenantId, limit: 200 } }),
    enabled: open,
  });

  const [supplierId, setSupplierId] = React.useState<string | null>(null);
  const [referenceInvoiceId, setReferenceInvoiceId] = React.useState<string | null>(null);
  const [creditNoteNumber, setCreditNoteNumber] = React.useState("");
  const [creditDate, setCreditDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = React.useState("TZS");
  const [subtotal, setSubtotal] = React.useState(0);
  const [taxTotal, setTaxTotal] = React.useState(0);
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setSupplierId(null);
    setReferenceInvoiceId(null);
    setCreditNoteNumber("");
    setCreditDate(new Date().toISOString().slice(0, 10));
    setCurrency("TZS");
    setSubtotal(0);
    setTaxTotal(0);
    setReason("");
    setNotes("");
  }, [open]);

  const invoiceRows = (invoices.data ?? []) as any[];
  const selectedInvoice = invoiceRows.find((invoice) => invoice.id === referenceInvoiceId);
  const supplierOptions = ((suppliers.data ?? []) as any[]).map((supplier) => ({
    value: supplier.id,
    label: supplier.name,
    hint: supplier.code ?? undefined,
  }));
  const invoiceOptions = invoiceRows
    .filter((invoice) => !supplierId || invoice.supplier_id === supplierId)
    .map((invoice) => ({
      value: invoice.id,
      label: invoice.supplier_invoice_number ?? invoice.document_number,
      hint: `${invoice.currency} · ${formatMoney(invoice.total, invoice.currency)}`,
    }));

  const save = useAdminMutation({
    mutationFn: () =>
      recordFn({
        data: {
          tenantId,
          supplierId: supplierId!,
          referenceInvoiceId: referenceInvoiceId ?? undefined,
          propertyId: selectedInvoice?.property_id ?? undefined,
          locationId: selectedInvoice?.location_id ?? undefined,
          supplierCreditNoteNumber: creditNoteNumber.trim(),
          creditDate,
          currency,
          subtotal,
          taxTotal,
          reason: reason.trim(),
          notes: notes.trim() || undefined,
        },
      }),
    successMessage: "Supplier credit note recorded",
    loadingMessage: "Recording credit note…",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.credit-notes", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
      onOpenChange(false);
    },
  });

  const canSubmit =
    Boolean(supplierId) &&
    creditNoteNumber.trim().length > 0 &&
    reason.trim().length >= 5 &&
    subtotal + taxTotal > 0;

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title="Record supplier credit note"
      description="Capture the supplier-issued credit as an immutable document. Applying it to an invoice is a separate, audited action."
      submitLabel="Record credit note"
      pending={save.isPending}
      disabled={!canSubmit}
      onSubmit={() => save.mutate(undefined)}
    >
      <FieldRow>
        <Field label="Supplier" required>
          <SearchSelect
            options={supplierOptions}
            value={supplierId}
            onChange={(value) => {
              setSupplierId(value);
              setReferenceInvoiceId(null);
            }}
            placeholder="Select supplier…"
          />
        </Field>
        <Field label="Supplier credit note number" required>
          <Input
            className="h-11"
            value={creditNoteNumber}
            onChange={(event) => setCreditNoteNumber(event.target.value)}
            placeholder="e.g. CN-2048"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Credit date" required>
          <Input
            type="date"
            className="h-11"
            value={creditDate}
            onChange={(event) => setCreditDate(event.target.value)}
          />
        </Field>
        <Field label="Reference invoice">
          <SearchSelect
            options={invoiceOptions}
            value={referenceInvoiceId}
            onChange={(value) => {
              setReferenceInvoiceId(value);
              const invoice = invoiceRows.find((row) => row.id === value);
              if (invoice) {
                setSupplierId(invoice.supplier_id);
                setCurrency(invoice.currency ?? "TZS");
              }
            }}
            placeholder="Optional invoice reference…"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Currency">
          <Input
            className="h-11"
            value={currency}
            maxLength={3}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Net credit amount" required>
          <QuantityField value={subtotal} onChange={setSubtotal} step={100} min={0} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Tax credit">
          <QuantityField value={taxTotal} onChange={setTaxTotal} step={100} min={0} />
        </Field>
        <Field label="Total credit">
          <div className="flex h-11 items-center rounded-md border px-3 text-sm font-medium">
            {formatMoney(subtotal + taxTotal, currency)}
          </div>
        </Field>
      </FieldRow>
      <Field label="Reason" required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
    </EntitySheet>
  );
}

interface ApplyProps extends SheetProps {
  creditNote: any | null;
}

export function ApplySupplierCreditNoteSheet({
  open,
  onOpenChange,
  tenantId,
  creditNote,
}: ApplyProps) {
  const qc = useQueryClient();
  const invoicesFn = useServerFn(listRestaurantSupplierInvoicesFn);
  const applyFn = useServerFn(applyRestaurantSupplierCreditNoteFn);
  const invoices = useQuery({
    queryKey: ["restaurant.procurement.invoices", tenantId],
    queryFn: () => invoicesFn({ data: { tenantId, limit: 200 } }),
    enabled: open && Boolean(creditNote),
  });

  const invoiceOptions = ((invoices.data ?? []) as any[])
    .filter(
      (invoice) =>
        invoice.supplier_id === creditNote?.supplier_id &&
        invoice.currency === creditNote?.currency &&
        invoice.status !== "cancelled" &&
        (!creditNote?.reference_invoice_id || invoice.id === creditNote.reference_invoice_id),
    )
    .map((invoice) => ({
      value: invoice.id,
      label: invoice.supplier_invoice_number ?? invoice.document_number,
      hint: `${formatMoney(
        Number(invoice.total ?? 0) -
          Number(invoice.amount_paid ?? 0) -
          Number(invoice.credit_applied ?? 0),
        invoice.currency,
      )} outstanding`,
    }));

  const [invoiceId, setInvoiceId] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState(0);
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (!open || !creditNote) return;
    setInvoiceId(null);
    setAmount(Number(creditNote.remaining_amount ?? creditNote.total ?? 0));
    setReason("Apply supplier credit note");
  }, [open, creditNote?.id]);

  const apply = useAdminMutation({
    mutationFn: () =>
      applyFn({
        data: {
          tenantId,
          creditNoteId: creditNote!.id,
          invoiceId: invoiceId!,
          amount,
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    successMessage: "Supplier credit applied to invoice",
    loadingMessage: "Applying supplier credit…",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.credit-notes", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.invoices", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title="Apply supplier credit"
      description={
        creditNote
          ? `${creditNote.supplier_credit_note_number} · remaining ${formatMoney(creditNote.remaining_amount, creditNote.currency)}`
          : "Apply supplier credit to an invoice."
      }
      submitLabel="Apply credit"
      pending={apply.isPending}
      disabled={!creditNote || !invoiceId || amount <= 0 || !reason.trim()}
      onSubmit={() => apply.mutate(undefined)}
    >
      <Field label="Target invoice" required>
        <SearchSelect
          options={invoiceOptions}
          value={invoiceId}
          onChange={setInvoiceId}
          placeholder="Select an invoice…"
        />
      </Field>
      <FieldRow>
        <Field label={`Credit amount (${creditNote?.currency ?? "TZS"})`} required>
          <QuantityField value={amount} onChange={setAmount} step={100} min={0} />
        </Field>
        <Field label="Available credit">
          <div className="flex h-11 items-center rounded-md border px-3 text-sm font-medium">
            {formatMoney(creditNote?.remaining_amount ?? creditNote?.total ?? 0, creditNote?.currency)}
          </div>
        </Field>
      </FieldRow>
      <Field label="Application reason" required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </EntitySheet>
  );
}
