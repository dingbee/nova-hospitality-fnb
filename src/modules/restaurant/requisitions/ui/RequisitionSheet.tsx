/**
 * New / edit requisition — draft header + line editor.
 */
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect, type SearchOption } from "../../ui/forms";
import { REQUISITION_KINDS, type RequisitionKind } from "../contracts";

export interface RequisitionDraftLine {
  key: string;
  inventoryItemId: string;
  unitId?: string;
  requestedQuantity: number;
  notes?: string;
}

interface RequisitionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationOptions: SearchOption[];
  itemOptions: SearchOption[];
  unitOptions: SearchOption[];
  pending?: boolean;
  onSubmit: (payload: {
    kind: RequisitionKind;
    department?: string;
    sourceLocationId: string;
    destinationLocationId: string;
    requiredDate?: string;
    notes?: string;
    submit: boolean;
    lines: RequisitionDraftLine[];
  }) => void;
}

let keySeq = 0;
const newKey = () => `line-${++keySeq}`;

export function RequisitionSheet({
  open,
  onOpenChange,
  locationOptions,
  itemOptions,
  unitOptions,
  pending,
  onSubmit,
}: RequisitionSheetProps) {
  const [kind, setKind] = React.useState<RequisitionKind>("kitchen");
  const [department, setDepartment] = React.useState("");
  const [sourceLocationId, setSourceLocationId] = React.useState<string | null>(null);
  const [destinationLocationId, setDestinationLocationId] = React.useState<string | null>(null);
  const [requiredDate, setRequiredDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<RequisitionDraftLine[]>([
    { key: newKey(), inventoryItemId: "", requestedQuantity: 1 },
  ]);

  React.useEffect(() => {
    if (!open) {
      setKind("kitchen");
      setDepartment("");
      setSourceLocationId(null);
      setDestinationLocationId(null);
      setRequiredDate("");
      setNotes("");
      setLines([{ key: newKey(), inventoryItemId: "", requestedQuantity: 1 }]);
    }
  }, [open]);

  const updateLine = (key: string, patch: Partial<RequisitionDraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const canSave =
    Boolean(sourceLocationId) &&
    Boolean(destinationLocationId) &&
    sourceLocationId !== destinationLocationId &&
    lines.length > 0 &&
    lines.every((l) => l.inventoryItemId && l.requestedQuantity > 0);

  const submit = (submitNow: boolean) => {
    if (!sourceLocationId || !destinationLocationId) return;
    onSubmit({
      kind,
      department: department || undefined,
      sourceLocationId,
      destinationLocationId,
      requiredDate: requiredDate || undefined,
      notes: notes || undefined,
      submit: submitNow,
      lines,
    });
  };

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title="New requisition"
      description="Request stock from a store for a kitchen, bar or department."
      submitLabel="Save & submit"
      pending={pending}
      disabled={!canSave}
      onSubmit={() => submit(true)}
      wide
      footerExtra={
        <Button type="button" variant="outline" className="h-11" disabled={pending || !canSave} onClick={() => submit(false)}>
          Save draft
        </Button>
      }
    >
      <FieldRow>
        <Field label="Kind" required>
          <select
            className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as RequisitionKind)}
          >
            {REQUISITION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k[0].toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Department" hint="Optional label, e.g. 'Pastry'">
          <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Department" />
        </Field>
      </FieldRow>

      <FieldRow>
        <Field label="Source store" required>
          <SearchSelect
            options={locationOptions}
            value={sourceLocationId}
            onChange={setSourceLocationId}
            placeholder="Store to draw from…"
          />
        </Field>
        <Field label="Destination" required>
          <SearchSelect
            options={locationOptions.filter((o) => o.value !== sourceLocationId)}
            value={destinationLocationId}
            onChange={setDestinationLocationId}
            placeholder="Kitchen / bar / department…"
          />
        </Field>
      </FieldRow>

      <FieldRow>
        <Field label="Required date">
          <Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
        </Field>
      </FieldRow>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Lines</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLines((prev) => [...prev, { key: newKey(), inventoryItemId: "", requestedQuantity: 1 }])}
          >
            <Plus className="mr-1 h-4 w-4" /> Add line
          </Button>
        </div>
        <div className="space-y-3">
          {lines.map((l) => (
            <div key={l.key} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <SearchSelect
                  options={itemOptions}
                  value={l.inventoryItemId || null}
                  onChange={(v) => updateLine(l.key, { inventoryItemId: v ?? "" })}
                  placeholder="Inventory item…"
                />
                <SearchSelect
                  options={unitOptions}
                  value={l.unitId ?? null}
                  onChange={(v) => updateLine(l.key, { unitId: v ?? undefined })}
                  placeholder="Unit (optional)…"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <QuantityField
                  value={l.requestedQuantity}
                  onChange={(v) => updateLine(l.key, { requestedQuantity: v })}
                  step={1}
                  min={0.001}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11 shrink-0 text-destructive"
                  disabled={lines.length <= 1}
                  onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  aria-label="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                value={l.notes ?? ""}
                onChange={(e) => updateLine(l.key, { notes: e.target.value })}
                placeholder="Line notes (optional)"
                className="min-h-9"
              />
            </div>
          ))}
        </div>
      </div>
    </EntitySheet>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-medium">{children}</span>;
}
