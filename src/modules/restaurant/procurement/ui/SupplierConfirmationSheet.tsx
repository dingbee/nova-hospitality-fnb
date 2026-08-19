/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Supplier confirmation — what the supplier actually committed to.
 *
 * The purchase order stays as issued: this sheet records a separate fact
 * against it (quantities, prices and delivery date the supplier agreed).
 * ENTER → REVIEW → CONFIRM: differences against the order are shown before
 * anything is written, and land in the existing variance workflow.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/os/StatusChip";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { getRestaurantPurchaseOrderDetailFn } from "@/modules/restaurant/purchasing/purchasing.functions";
import { recordRestaurantSupplierConfirmationFn } from "../procurement.functions";
import { CONFIRMATION_STATUSES } from "../contracts";
import { formatMoney } from "../lifecycle";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  purchaseOrderId: string | null;
}

interface LineState {
  quantity: number;
  unitPrice: number;
}

export function SupplierConfirmationSheet({ open, onOpenChange, tenantId, purchaseOrderId }: Props) {
  const qc = useQueryClient();
  const detailFn = useServerFn(getRestaurantPurchaseOrderDetailFn);
  const recordFn = useServerFn(recordRestaurantSupplierConfirmationFn);

  const detail = useQuery({
    queryKey: ["restaurant.purchase-order.detail", tenantId, purchaseOrderId],
    queryFn: () => detailFn({ data: { tenantId, id: purchaseOrderId! } }),
    enabled: open && Boolean(purchaseOrderId),
  });
  const d = detail.data as any;
  const items: any[] = d?.items ?? [];
  const currency: string = d?.order?.currency ?? "TZS";

  const [status, setStatus] = React.useState<(typeof CONFIRMATION_STATUSES)[number]>("confirmed");
  const [supplierReference, setSupplierReference] = React.useState("");
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<Record<string, LineState>>({});

  React.useEffect(() => {
    if (!open) return;
    setStatus("confirmed");
    setSupplierReference("");
    setNotes("");
  }, [open, purchaseOrderId]);

  React.useEffect(() => {
    if (!open || items.length === 0) return;
    setLines(
      Object.fromEntries(items.map((i) => [i.id, { quantity: Number(i.quantity), unitPrice: Number(i.unit_price) }])),
    );
    setDeliveryDate((prev) => prev || (d?.order?.expected_at ? String(d.order.expected_at).slice(0, 10) : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, d?.order?.id, items.length]);

  const differences = items.filter((i) => {
    const l = lines[i.id];
    if (!l) return false;
    return l.quantity !== Number(i.quantity) || l.unitPrice !== Number(i.unit_price);
  });
  const confirmedTotal = items.reduce((s, i) => {
    const l = lines[i.id];
    return s + (l ? l.quantity * l.unitPrice : 0);
  }, 0);

  const record = useAdminMutation({
    mutationFn: () =>
      recordFn({
        data: {
          tenantId,
          purchaseOrderId: purchaseOrderId!,
          status,
          supplierReference: supplierReference || undefined,
          confirmedDeliveryDate: deliveryDate || undefined,
          notes: notes || undefined,
          lines: items.map((i) => ({
            purchaseOrderItemId: i.id,
            confirmedQuantity: lines[i.id]?.quantity ?? 0,
            confirmedUnitPrice: lines[i.id]?.unitPrice ?? 0,
            confirmedDeliveryDate: deliveryDate || undefined,
          })),
        },
      }),
    successMessage: "Supplier confirmation recorded",
    loadingMessage: "Recording confirmation…",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.purchase-orders", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.purchase-order.detail", tenantId, purchaseOrderId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.variances", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.procurement.overview", tenantId] });
      onOpenChange(false);
    },
  });

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={`Supplier confirmation — ${d?.order?.document_number ?? d?.order?.reference ?? "purchase order"}`}
      description="Records what the supplier committed to. The purchase order itself is never rewritten."
      submitLabel="Record confirmation"
      pending={record.isPending}
      disabled={!purchaseOrderId || items.length === 0 || detail.isLoading}
      onSubmit={() => record.mutate(undefined)}
    >
      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the order…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This order has no lines to confirm. Add lines to the purchase order first.
        </p>
      ) : (
        <>
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">{d?.supplier?.name ?? "Supplier not set"}</div>
            <div className="text-xs text-muted-foreground">
              Ordered {formatMoney(d?.order?.total ?? 0, currency)} · status {d?.order?.status}
              {d?.order?.expected_at ? ` · expected ${String(d.order.expected_at).slice(0, 10)}` : ""}
            </div>
          </div>

          <FieldRow>
            <Field label="Confirmation status" required>
              <SearchSelect
                options={CONFIRMATION_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
                value={status}
                allowClear={false}
                onChange={(v) => setStatus((v as typeof status) ?? "confirmed")}
              />
            </Field>
            <Field label="Supplier reference" hint="Their order acknowledgement number.">
              <Input
                className="h-11"
                value={supplierReference}
                onChange={(e) => setSupplierReference(e.target.value)}
                placeholder="e.g. ACK-4472"
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Confirmed delivery date">
              <Input
                type="date"
                className="h-11"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </Field>
            <Field label="Confirmed value">
              <div className="flex h-11 items-center rounded-md border px-3 text-sm font-medium">
                {formatMoney(confirmedTotal, currency)}
              </div>
            </Field>
          </FieldRow>

          <div className="space-y-3">
            <p className="text-sm font-medium">Confirmed lines</p>
            {items.map((i) => {
              const l = lines[i.id] ?? { quantity: 0, unitPrice: 0 };
              const qtyChanged = l.quantity !== Number(i.quantity);
              const priceChanged = l.unitPrice !== Number(i.unit_price);
              return (
                <div key={i.id} className="space-y-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{i.description}</span>
                    <span className="text-xs text-muted-foreground">
                      ordered {Number(i.quantity)} @ {formatMoney(i.unit_price, currency)}
                    </span>
                  </div>
                  <FieldRow>
                    <Field label="Confirmed quantity">
                      <QuantityField
                        value={l.quantity}
                        onChange={(v) => setLines((p) => ({ ...p, [i.id]: { ...l, quantity: v } }))}
                        step={1}
                        min={0}
                      />
                    </Field>
                    <Field label="Confirmed unit price">
                      <QuantityField
                        value={l.unitPrice}
                        onChange={(v) => setLines((p) => ({ ...p, [i.id]: { ...l, unitPrice: v } }))}
                        step={100}
                        min={0}
                      />
                    </Field>
                  </FieldRow>
                  {(qtyChanged || priceChanged) && (
                    <div className="flex flex-wrap gap-2">
                      {qtyChanged ? <StatusChip tone="warning">quantity differs</StatusChip> : null}
                      {priceChanged ? <StatusChip tone="warning">price differs</StatusChip> : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Review before confirming</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {differences.length === 0
                ? "The supplier confirmed the order exactly as issued."
                : `${differences.length} line(s) differ from the order. Each difference is recorded as a variance for a person to resolve — nothing is auto-approved.`}
            </p>
          </div>
        </>
      )}
    </EntitySheet>
  );
}