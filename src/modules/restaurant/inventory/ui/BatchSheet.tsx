/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Batch / lot entry.
 *
 * A batch records *which* physical lot is on the shelf and when it expires.
 * It does not move stock — quantity here is the lot's opening quantity, and
 * the stock ledger remains the only thing that changes balances.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { listRestaurantInventoryFn } from "../inventory.functions";
import { listInventoryLocationsFn, upsertInventoryBatchFn } from "../control.functions";
import { listRestaurantSuppliersFn } from "@/modules/restaurant/suppliers/suppliers.functions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  /** Existing batch row to edit, if any. */
  batch?: any | null;
}

export function BatchSheet({ open, onOpenChange, tenantId, batch }: Props) {
  const qc = useQueryClient();
  const itemsFn = useServerFn(listRestaurantInventoryFn);
  const locationsFn = useServerFn(listInventoryLocationsFn);
  const suppliersFn = useServerFn(listRestaurantSuppliersFn);
  const saveFn = useServerFn(upsertInventoryBatchFn);

  const items = useQuery({
    queryKey: ["restaurant.inventory", tenantId],
    queryFn: () => itemsFn({ data: { tenantId, lowOnly: false, limit: 300 } }),
    enabled: open,
  });
  const locations = useQuery({
    queryKey: ["restaurant.inventory.locations", tenantId],
    queryFn: () => locationsFn({ data: { tenantId, storageOnly: true, includeInactive: false } }),
    enabled: open,
  });
  const suppliers = useQuery({
    queryKey: ["restaurant.suppliers", tenantId],
    queryFn: () => suppliersFn({ data: { tenantId, limit: 200 } }),
    enabled: open,
  });

  const [inventoryItemId, setInventoryItemId] = React.useState<string | null>(null);
  const [locationId, setLocationId] = React.useState<string | null>(null);
  const [supplierId, setSupplierId] = React.useState<string | null>(null);
  const [batchNumber, setBatchNumber] = React.useState("");
  const [receivedDate, setReceivedDate] = React.useState("");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [quantity, setQuantity] = React.useState(0);
  const [unitCost, setUnitCost] = React.useState(0);
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setInventoryItemId(batch?.inventory_item_id ?? null);
    setLocationId(batch?.location_id ?? null);
    setSupplierId(batch?.supplier_id ?? null);
    setBatchNumber(batch?.batch_number ?? "");
    setReceivedDate(batch?.received_date ? String(batch.received_date).slice(0, 10) : new Date().toISOString().slice(0, 10));
    setExpiryDate(batch?.expiry_date ? String(batch.expiry_date).slice(0, 10) : "");
    setQuantity(Number(batch?.quantity ?? 0));
    setUnitCost(Number(batch?.unit_cost ?? 0));
    setNotes(batch?.notes ?? "");
  }, [open, batch]);

  const save = useAdminMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          id: batch?.id ?? undefined,
          inventoryItemId: inventoryItemId!,
          locationId: locationId ?? undefined,
          supplierId: supplierId ?? undefined,
          batchNumber: batchNumber.trim(),
          receivedDate: receivedDate || undefined,
          expiryDate: expiryDate || undefined,
          quantity,
          unitCost,
          notes: notes || undefined,
        },
      }),
    successMessage: batch?.id ? "Batch updated" : "Batch recorded",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.inventory.batches", tenantId] });
      void qc.invalidateQueries({ queryKey: ["restaurant.inventory.overview", tenantId] });
      onOpenChange(false);
    },
  });

  const itemOptions = ((items.data ?? []) as any[]).map((i) => ({ value: i.id, label: i.name, hint: i.sku ?? undefined }));
  const locationOptions = ((locations.data ?? []) as any[]).map((l) => ({ value: l.id, label: l.name, hint: l.code ?? undefined }));
  const supplierOptions = ((suppliers.data ?? []) as any[]).map((s) => ({ value: s.id, label: s.name }));

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={batch?.id ? "Edit batch" : "Record batch"}
      description="Lot identity and expiry. Balances still come from the stock ledger."
      submitLabel={batch?.id ? "Save batch" : "Record batch"}
      pending={save.isPending}
      disabled={!inventoryItemId || batchNumber.trim().length === 0}
      onSubmit={() => save.mutate(undefined)}
    >
      <Field label="Stock item" required>
        <SearchSelect options={itemOptions} value={inventoryItemId} onChange={setInventoryItemId} placeholder="Select stock item…" />
      </Field>
      <FieldRow>
        <Field label="Batch / lot number" required>
          <Input className="h-11" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder="e.g. LOT-2411" />
        </Field>
        <Field label="Storage location">
          <SearchSelect options={locationOptions} value={locationId} onChange={setLocationId} placeholder="Select location…" />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Received date">
          <Input type="date" className="h-11" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
        </Field>
        <Field label="Expiry date" hint="Leave empty for non-perishable lots.">
          <Input type="date" className="h-11" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Quantity">
          <QuantityField value={quantity} onChange={setQuantity} step={1} min={0} />
        </Field>
        <Field label="Unit cost">
          <QuantityField value={unitCost} onChange={setUnitCost} step={100} min={0} />
        </Field>
      </FieldRow>
      <Field label="Supplier">
        <SearchSelect options={supplierOptions} value={supplierId} onChange={setSupplierId} placeholder="Select supplier…" />
      </Field>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </EntitySheet>
  );
}