import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantInventoryItemFn } from "@/modules/restaurant/inventory/inventory.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData } from "../types";

type Item = MasterData["inventoryItems"][number];

const empty = {
  name: "",
  sku: "",
  categoryId: "" as string | null,
  unitId: "" as string | null,
  purchaseUnitId: "" as string | null,
  consumptionUnitId: "" as string | null,
  currentQuantity: 0,
  parLevel: 0,
  reorderPoint: 0,
  averageCost: 0,
  trackBatches: false,
  allowNegative: false,
};

export function ItemsPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Item | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantInventoryItemFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Item saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const items: Item[] = data.inventoryItems ?? [];
  const filtered = items.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
  const categoryOptions = (data.inventoryCategories ?? []).map((c) => ({ value: c.id, label: c.name }));
  const unitOptions = (data.units ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const i = items.find((x) => x.id === id);
    if (!i) return;
    setEditing(i);
    setForm({
      name: i.name,
      sku: i.sku ?? "",
      categoryId: i.category_id ?? null,
      unitId: i.unit_id ?? null,
      purchaseUnitId: i.purchase_unit_id ?? null,
      consumptionUnitId: i.consumption_unit_id ?? null,
      currentQuantity: i.current_quantity ?? 0,
      parLevel: i.par_level ?? 0,
      reorderPoint: i.reorder_point ?? 0,
      averageCost: i.average_cost ?? 0,
      trackBatches: i.track_batches ?? false,
      allowNegative: i.allow_negative ?? false,
    });
    setOpen(true);
  }

  return (
    <SectionCard title="Inventory items" description="Stock keeping units used by inventory, recipes and purchasing.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New item" />
        <PanelList
          items={filtered.map((i) => ({ id: i.id, title: i.name, subtitle: i.sku ?? i.item_type, active: i.status === "active" }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const i = items.find((x) => x.id === id);
            if (!i) return;
            mutation.mutate({
              data: {
                tenantId,
                id: i.id,
                name: i.name,
                sku: i.sku ?? undefined,
                categoryId: i.category_id ?? undefined,
                unitId: i.unit_id ?? undefined,
                itemType: i.item_type,
                currentQuantity: i.current_quantity ?? 0,
                averageCost: i.average_cost ?? 0,
                currency: i.currency,
                trackBatches: i.track_batches ?? false,
                allowNegative: i.allow_negative ?? false,
                purchaseUnitId: i.purchase_unit_id ?? undefined,
                consumptionUnitId: i.consumption_unit_id ?? undefined,
                status: active ? "active" : "inactive",
              } as never,
            });
          }}
          emptyTitle="No inventory items yet"
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit item" : "New item"}
        wide
        onSubmit={() =>
          mutation.mutate({
            data: {
              tenantId,
              id: editing?.id,
              name: form.name,
              sku: form.sku || undefined,
              categoryId: form.categoryId || undefined,
              unitId: form.unitId || undefined,
              currentQuantity: form.currentQuantity,
              parLevel: form.parLevel,
              reorderPoint: form.reorderPoint,
              averageCost: form.averageCost,
              trackBatches: form.trackBatches,
              allowNegative: form.allowNegative,
              purchaseUnitId: form.purchaseUnitId || undefined,
              consumptionUnitId: form.consumptionUnitId || undefined,
            },
          })
        }
        pending={mutation.isPending}
        disabled={!form.name}
      >
        <FieldRow>
          <Field label="Name" required>
            <Input className="h-11" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="SKU">
            <Input className="h-11" value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Category">
            <SearchSelect options={categoryOptions} value={form.categoryId} onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))} placeholder="Select category" />
          </Field>
          <Field label="Stock unit">
            <SearchSelect options={unitOptions} value={form.unitId} onChange={(v) => setForm((f) => ({ ...f, unitId: v }))} placeholder="Select unit" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Purchase unit" hint="Unit used on purchase orders.">
            <SearchSelect options={unitOptions} value={form.purchaseUnitId} onChange={(v) => setForm((f) => ({ ...f, purchaseUnitId: v }))} placeholder="Same as stock" />
          </Field>
          <Field label="Consumption unit" hint="Unit used in recipes.">
            <SearchSelect options={unitOptions} value={form.consumptionUnitId} onChange={(v) => setForm((f) => ({ ...f, consumptionUnitId: v }))} placeholder="Same as stock" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Opening quantity">
            <QuantityField value={form.currentQuantity} onChange={(v) => setForm((f) => ({ ...f, currentQuantity: v }))} step={1} />
          </Field>
          <Field label="Average cost">
            <QuantityField value={form.averageCost} onChange={(v) => setForm((f) => ({ ...f, averageCost: v }))} step={100} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Par level">
            <QuantityField value={form.parLevel} onChange={(v) => setForm((f) => ({ ...f, parLevel: v }))} step={1} />
          </Field>
          <Field label="Reorder point">
            <QuantityField value={form.reorderPoint} onChange={(v) => setForm((f) => ({ ...f, reorderPoint: v }))} step={1} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Track batches">
            <Switch checked={form.trackBatches} onCheckedChange={(v) => setForm((f) => ({ ...f, trackBatches: v }))} />
          </Field>
          <Field label="Allow negative stock">
            <Switch checked={form.allowNegative} onCheckedChange={(v) => setForm((f) => ({ ...f, allowNegative: v }))} />
          </Field>
        </FieldRow>
      </EntitySheet>
    </SectionCard>
  );
}
