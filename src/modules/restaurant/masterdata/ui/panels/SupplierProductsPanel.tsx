import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantSupplierProductFn } from "@/modules/restaurant/suppliers/suppliers.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData, SupplierProductRow } from "../types";

const empty = {
  supplierId: "" as string | null,
  inventoryItemId: "" as string | null,
  unitId: "" as string | null,
  supplierSku: "",
  name: "",
  packSize: 0,
  unitPrice: 0,
  currency: "TZS",
  minOrderQuantity: 0,
  leadTimeDays: 0,
};

export function SupplierProductsPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SupplierProductRow | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantSupplierProductFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Supplier product saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const products: SupplierProductRow[] = data.supplierProducts ?? [];
  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  const supplierOptions = (data.suppliers ?? []).map((s) => ({ value: s.id, label: s.name }));
  const itemOptions = (data.inventoryItems ?? []).map((i) => ({ value: i.id, label: i.name }));
  const unitOptions = (data.units ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }));
  const supplierName = (id: string) => data.suppliers.find((s) => s.id === id)?.name ?? "Unknown supplier";

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    setEditing(p);
    setForm({
      supplierId: p.supplier_id,
      inventoryItemId: p.inventory_item_id,
      unitId: p.unit_id,
      supplierSku: p.supplier_sku ?? "",
      name: p.name,
      packSize: p.pack_size ?? 0,
      unitPrice: p.unit_price ?? 0,
      currency: p.currency,
      minOrderQuantity: p.min_order_quantity ?? 0,
      leadTimeDays: p.lead_time_days ?? 0,
    });
    setOpen(true);
  }

  function save(active: boolean) {
    if (!form.supplierId) return;
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        supplierId: form.supplierId,
        inventoryItemId: form.inventoryItemId || undefined,
        unitId: form.unitId || undefined,
        supplierSku: form.supplierSku || undefined,
        name: form.name,
        packSize: form.packSize || undefined,
        unitPrice: form.unitPrice,
        currency: form.currency,
        minOrderQuantity: form.minOrderQuantity || undefined,
        leadTimeDays: form.leadTimeDays || undefined,
        active,
      },
    });
  }

  return (
    <SectionCard title="Supplier products" description="Priced catalogue items each supplier can deliver, linked to inventory items and purchase units.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New supplier product" />
        <PanelList
          items={filtered.map((p) => ({
            id: p.id,
            title: p.name,
            subtitle: `${supplierName(p.supplier_id)} · ${p.currency} ${p.unit_price.toLocaleString()}`,
            active: p.active,
          }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const p = products.find((x) => x.id === id);
            if (!p) return;
            mutation.mutate({
              data: {
                tenantId,
                id: p.id,
                supplierId: p.supplier_id,
                inventoryItemId: p.inventory_item_id ?? undefined,
                unitId: p.unit_id ?? undefined,
                supplierSku: p.supplier_sku ?? undefined,
                name: p.name,
                packSize: p.pack_size ?? undefined,
                unitPrice: p.unit_price,
                currency: p.currency,
                minOrderQuantity: p.min_order_quantity ?? undefined,
                leadTimeDays: p.lead_time_days ?? undefined,
                active,
              },
            });
          }}
          emptyTitle="No supplier products yet"
          emptyDescription="Add suppliers first, then price the goods they deliver."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit supplier product" : "New supplier product"}
        onSubmit={() => save(true)}
        pending={mutation.isPending}
        disabled={!form.name || !form.supplierId || form.unitPrice < 0}
      >
        <Field label="Supplier" required>
          <SearchSelect options={supplierOptions} value={form.supplierId} onChange={(v) => setForm((f) => ({ ...f, supplierId: v }))} placeholder="Select supplier" allowClear={false} />
        </Field>
        <Field label="Name" required>
          <Input className="h-11" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
        </Field>
        <FieldRow>
          <Field label="Inventory item">
            <SearchSelect options={itemOptions} value={form.inventoryItemId} onChange={(v) => setForm((f) => ({ ...f, inventoryItemId: v }))} placeholder="Link an item" />
          </Field>
          <Field label="Unit">
            <SearchSelect options={unitOptions} value={form.unitId} onChange={(v) => setForm((f) => ({ ...f, unitId: v }))} placeholder="Select unit" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Supplier SKU">
            <Input className="h-11" value={form.supplierSku} onChange={(e) => setForm((f) => ({ ...f, supplierSku: e.target.value }))} />
          </Field>
          <Field label="Currency" required>
            <Input className="h-11" maxLength={3} value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} required />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Pack size">
            <QuantityField value={form.packSize} onChange={(v) => setForm((f) => ({ ...f, packSize: v }))} step={1} />
          </Field>
          <Field label="Unit price" required>
            <QuantityField value={form.unitPrice} onChange={(v) => setForm((f) => ({ ...f, unitPrice: v }))} step={100} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Min order quantity">
            <QuantityField value={form.minOrderQuantity} onChange={(v) => setForm((f) => ({ ...f, minOrderQuantity: v }))} step={1} />
          </Field>
          <Field label="Lead time (days)">
            <QuantityField value={form.leadTimeDays} onChange={(v) => setForm((f) => ({ ...f, leadTimeDays: v }))} step={1} />
          </Field>
        </FieldRow>
      </EntitySheet>
    </SectionCard>
  );
}
