/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Supplier invoice entry with three-way matching.
 *
 * Lines prefill from what was *received*, not what was ordered, so the common
 * case is a one-tap agreement and any disagreement is visible before saving.
 * Matching stays server-side: this sheet records the invoice, then asks the
 * matcher to run. Nothing is marked matched by the browser.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/os/StatusChip";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { getRestaurantPurchaseOrderDetailFn } from "@/modules/restaurant/purchasing/purchasing.functions";
import { listRestaurantSuppliersFn } from "@/modules/restaurant/suppliers/suppliers.functions";
import { recordRestaurantSupplierInvoiceFn, matchRestaurantSupplierInvoiceFn } from "../procurement.functions";
import { formatMoney } from "../lifecycle";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  /** When set, the invoice is entered against this order and prefills from it. */
  purchaseOrderId?: string | null;
  defaultCurrency?: string;
}

interface LineState {
  key: string;
  purchaseOrderItemId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxAmount: number;
  /** What we accepted on receipt — used for the match preview only. */
  acceptedQuantity?: number;
  orderedUnitPrice?: number;
}

let keySeed = 0;
const nextKey = () => `line-${++keySeed}`;

export function SupplierInvoiceSheet({ open, onOpenChange, tenantId, purchaseOrderId, defaultCurrency = "TZS" }: Props) {
  const qc = useQueryClient();
  const detailFn = useServerFn(getRestaurantPurchaseOrderDetailFn);
  const suppliersFn = useServerFn(listRestaurantSuppliersFn);
  const recordFn = useServerFn(recordRestaurantSupplierInvoiceFn);
  const matchFn = useServerFn(matchRestaurantSupplierInvoiceFn);

  const detail = useQuery({
    queryKey: ["restaurant.purchase-order.detail", tenantId, purchaseOrderId],
    queryFn: () => detailFn({ data: { tenantId, id: purchaseOrderId! } }),
    enabled: open && Boolean(purchaseOrderId),
  });
  const suppliers = useQuery({
    queryKey: ["restaurant.suppliers", tenantId],
    queryFn: () => suppliersFn({ data: { tenantId, limit: 200 } }),
    enabled: open,
  });
  const d = detail.data as any;

  const [supplierId, setSupplierId] = React.useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = React.useState("");
  const [invoiceDate, setInvoiceDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = React.useState("");
  const [taxTotal, setTaxTotal] = React.useState(0);
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<LineState[]>([]);
  const currency: string = d?.order?.currency ?? defaultCurrency;

  React.useEffect(() => {
    if (!open) return;
    setInvoiceNumber("");
    setDueDate("");
    setTaxTotal(0);
    setNotes("");
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    if (!purchaseOrderId) {
      setSupplierId(null);
      setLines([{ key: nextKey(), description: "", quantity: 1, unitPrice: 0, taxAmount: 0 }]);
    }
  }, [open, purchaseOrderId]);

  React.useEffect(() => {
    if (!open || !purchaseOrderId || !d?.order) return;
    setSupplierId(d.order.supplier_id ?? null);
    setLines(
      (d.items as any[]).map((i) => {
        const accepted = Number(i.accepted_quantity ?? 0);
        return {
          key: nextKey(),
          purchaseOrderItemId: i.id,
          description: i.description,
          // Invoice what we actually accepted; fall back to the order when nothing is received yet.
          quantity: accepted > 0 ? accepted : Number(i.quantity),
          unitPrice: Number(i.confirmed_unit_price ?? 0) || Number(i.unit_price),
          taxAmount: 0,
          acceptedQuantity: accepted,
          orderedUnitPrice: Number(i.unit_price),
        };
      }),
    );
  }, [open, purchaseOrderId, d?.order?.id]);

  const setLine = (key: string, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const netTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const grossTotal = netTotal + taxTotal;
  const mismatches = lines.filter(
    (l) =>
      (l.acceptedQuantity !== undefined && l.quantity !== l.acceptedQuantity) ||
      (l.orderedUnitPrice !== undefined && l.unitPrice !== l.orderedUnitPrice),
  );

  const save = useAdminMutation({
    mutationFn: async () => {
      const invoice: any = await recordFn({
        data: {
          tenantId,
          supplierId: supplierId!,
          purchaseOrderId: purchaseOrderId ?? undefined,
          propertyId: d?.order?.property_id ?? undefined,
          locationId: d?.order?.location_id ?? undefined,
          supplierInvoiceNumber: invoiceNumber.trim(),
          invoiceDate,
          dueDate: dueDate || undefined,
          currency,
          taxTotal,
          notes: notes || undefined,
          lines: lines
            .filter((l) => l.description.trim().length > 0)
            .map((l) => ({
              purchaseOrderItemId: l.purchaseOrderItemId,
              description: l.description.trim(),
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxAmount: l.taxAmount,
            })),
        },
      });
      // Matching is a server decision; we only request it once the invoice exists.
      if (purchaseOrderId && invoice?.id) {
        await matchFn({ data: { tenantId, invoiceId: invoice.id } });
      }
      return invoice;
    },
    successMessage: "Supplier invoice recorded",
    loadingMessage: "Recording invoice…",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.invoices", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.variances", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.purchase-order.detail", tenantId, purchaseOrderId] });
      onOpenChange(false);
    },
  });

  const supplierOptions = ((suppliers.data ?? []) as any[]).map((s) => ({ value: s.id, label: s.name, hint: s.code ?? undefined }));
  const canSubmit = Boolean(supplierId) && invoiceNumber.trim().length > 0 && lines.some((l) => l.description.trim());

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={purchaseOrderId ? `Invoice for ${d?.order?.document_number ?? d?.order?.reference ?? "order"}` : "Record supplier invoice"}
      description="Lines prefill from what was received. Matching runs on the server after the invoice is saved."
      submitLabel="Record invoice"
      pending={save.isPending}
      disabled={!canSubmit}
      onSubmit={() => save.mutate(undefined)}
      footerExtra={
        purchaseOrderId ? undefined : (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() =>
              setLines((prev) => [...prev, { key: nextKey(), description: "", quantity: 1, unitPrice: 0, taxAmount: 0 }])
            }
          >
            <Plus className="mr-1 h-4 w-4" /> Add line
          </Button>
        )
      }
    >
      <FieldRow>
        <Field label="Supplier" required>
          <SearchSelect
            options={supplierOptions}
            value={supplierId}
            onChange={setSupplierId}
            disabled={Boolean(purchaseOrderId)}
            placeholder="Select supplier…"
          />
        </Field>
        <Field label="Supplier invoice number" required>
          <Input className="h-11" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="e.g. INV-10233" />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Invoice date" required>
          <Input type="date" className="h-11" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Due date">
          <Input type="date" className="h-11" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </FieldRow>

      <div className="space-y-3">
        <p className="text-sm font-medium">Invoice lines</p>
        {lines.map((l) => {
          const qtyOff = l.acceptedQuantity !== undefined && l.quantity !== l.acceptedQuantity;
          const priceOff = l.orderedUnitPrice !== undefined && l.unitPrice !== l.orderedUnitPrice;
          return (
            <div key={l.key} className="space-y-3 rounded-md border p-3">
              <div className="flex items-start gap-2">
                <Input
                  className="h-11"
                  value={l.description}
                  onChange={(e) => setLine(l.key, { description: e.target.value })}
                  placeholder="Description"
                  readOnly={Boolean(l.purchaseOrderItemId)}
                />
                {!l.purchaseOrderItemId && lines.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              <FieldRow>
                <Field label="Quantity">
                  <QuantityField value={l.quantity} onChange={(v) => setLine(l.key, { quantity: v })} step={1} min={0} />
                </Field>
                <Field label="Unit price">
                  <QuantityField value={l.unitPrice} onChange={(v) => setLine(l.key, { unitPrice: v })} step={100} min={0} />
                </Field>
              </FieldRow>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Line {formatMoney(l.quantity * l.unitPrice, currency)}</span>
                {l.acceptedQuantity !== undefined ? <span>· received {l.acceptedQuantity}</span> : null}
                {qtyOff ? <StatusChip tone="warning">quantity vs receipt</StatusChip> : null}
                {priceOff ? <StatusChip tone="warning">price vs order</StatusChip> : null}
              </div>
            </div>
          );
        })}
      </div>

      <FieldRow>
        <Field label="Tax total">
          <QuantityField value={taxTotal} onChange={setTaxTotal} step={100} min={0} />
        </Field>
        <Field label="Invoice total">
          <div className="flex h-11 items-center rounded-md border px-3 text-sm font-medium">
            {formatMoney(grossTotal, currency)}
          </div>
        </Field>
      </FieldRow>

      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="rounded-md border p-3 text-sm">
        <p className="font-medium">Match preview</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {!purchaseOrderId
            ? "Standalone invoice — no order to match against."
            : mismatches.length === 0
              ? "Invoice agrees with the order and the goods received. Matching should pass cleanly."
              : `${mismatches.length} line(s) disagree with the order or the receipt. The invoice will be recorded and flagged for a person to resolve.`}
        </p>
      </div>
    </EntitySheet>
  );
}