/**
 * Create a purchase order directly against a supplier.
 *
 * A direct order bypasses the requisition stage, so it is an authorised
 * exception: the reason is mandatory and is written to the audit trail.
 */
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect, type SearchOption } from "../../ui/forms";

export interface PurchaseOrderLineValue {
  description: string;
  quantity: number;
  unitPrice: number;
  inventoryItemId: string | null;
}

export interface PurchaseOrderFormValue {
  supplierId: string | null;
  reference: string;
  expectedAt: string;
  currency: string;
  notes: string;
  directReason: string;
  lines: PurchaseOrderLineValue[];
}

const EMPTY_LINE: PurchaseOrderLineValue = { description: "", quantity: 1, unitPrice: 0, inventoryItemId: null };
const EMPTY: PurchaseOrderFormValue = {
  supplierId: null,
  reference: "",
  expectedAt: "",
  currency: "TZS",
  notes: "",
  directReason: "",
  lines: [{ ...EMPTY_LINE }],
};

export function PurchaseOrderSheet({
  open,
  onOpenChange,
  suppliers,
  items,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suppliers: SearchOption[];
  items: SearchOption[];
  onSubmit: (value: PurchaseOrderFormValue) => void;
  pending?: boolean;
}) {
  const [value, setValue] = React.useState<PurchaseOrderFormValue>(EMPTY);
  React.useEffect(() => {
    if (open) setValue(EMPTY);
  }, [open]);

  const total = value.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const valid =
    Boolean(value.supplierId) &&
    value.directReason.trim().length >= 10 &&
    value.lines.every((l) => l.description.trim() && l.quantity > 0);

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title="New purchase order"
      description="A direct order skips the requisition stage, so it needs an authorised reason. Receiving and invoicing happen later, against this order."
      submitLabel="Create order"
      pending={pending}
      disabled={!valid}
      wide
      onSubmit={() => onSubmit(value)}
    >
      <Field label="Supplier" required>
        <SearchSelect
          options={suppliers}
          value={value.supplierId}
          onChange={(v) => setValue((s) => ({ ...s, supplierId: v }))}
          placeholder="Choose a supplier…"
          allowClear={false}
        />
      </Field>
      <FieldRow>
        <Field label="Reference" hint="Optional, e.g. an internal PO number.">
          <Input className="h-11" value={value.reference} onChange={(e) => setValue((v) => ({ ...v, reference: e.target.value }))} />
        </Field>
        <Field label="Expected delivery">
          <Input className="h-11" type="date" value={value.expectedAt} onChange={(e) => setValue((v) => ({ ...v, expectedAt: e.target.value }))} />
        </Field>
      </FieldRow>
      <Field label="Currency" required>
        <Input className="h-11 w-32" value={value.currency} onChange={(e) => setValue((v) => ({ ...v, currency: e.target.value.toUpperCase() }))} />
      </Field>

      <Field
        label="Reason for ordering without a request"
        required
        hint="At least 10 characters, e.g. emergency purchase, approved operational exception. Recorded in the audit trail."
      >
        <Textarea
          rows={2}
          value={value.directReason}
          onChange={(e) => setValue((v) => ({ ...v, directReason: e.target.value }))}
        />
      </Field>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Lines</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9"
            onClick={() => setValue((v) => ({ ...v, lines: [...v.lines, { ...EMPTY_LINE }] }))}
          >
            <Plus className="mr-1 h-4 w-4" /> Add line
          </Button>
        </div>
        {value.lines.map((line, idx) => (
          <div key={idx} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Line {idx + 1}</span>
              {value.lines.length > 1 && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setValue((v) => ({ ...v, lines: v.lines.filter((_, i) => i !== idx) }))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Field label="Item" hint="Pick a stock item, or type a free-text description below.">
              <SearchSelect
                options={items}
                value={line.inventoryItemId}
                onChange={(v) =>
                  setValue((s) => ({
                    ...s,
                    lines: s.lines.map((l, i) =>
                      i === idx
                        ? { ...l, inventoryItemId: v, description: v ? items.find((o) => o.value === v)?.label ?? l.description : l.description }
                        : l,
                    ),
                  }))
                }
                placeholder="Link to a stock item (optional)"
              />
            </Field>
            <Field label="Description" required>
              <Input
                className="h-11"
                value={line.description}
                onChange={(e) =>
                  setValue((s) => ({ ...s, lines: s.lines.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)) }))
                }
              />
            </Field>
            <FieldRow>
              <Field label="Quantity" required>
                <QuantityField
                  value={line.quantity}
                  step={1}
                  onChange={(n) => setValue((s) => ({ ...s, lines: s.lines.map((l, i) => (i === idx ? { ...l, quantity: n } : l)) }))}
                />
              </Field>
              <Field label="Unit price">
                <QuantityField
                  value={line.unitPrice}
                  step={100}
                  suffix={value.currency}
                  onChange={(n) => setValue((s) => ({ ...s, lines: s.lines.map((l, i) => (i === idx ? { ...l, unitPrice: n } : l)) }))}
                />
              </Field>
            </FieldRow>
          </div>
        ))}
      </div>

      <Field label="Notes">
        <Textarea rows={2} value={value.notes} onChange={(e) => setValue((v) => ({ ...v, notes: e.target.value }))} />
      </Field>

      <p className="text-sm text-muted-foreground">
        Order total: {value.currency} {total.toLocaleString()}
      </p>
    </EntitySheet>
  );
}
