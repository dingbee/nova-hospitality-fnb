import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantInventoryCategoryFn, upsertRestaurantProductCategoryFn } from "../../masterdata.functions";
import { PanelList, PanelToolbar, slugify } from "../shared";
import type { MasterData } from "../types";

type InvCat = MasterData["inventoryCategories"][number];
type ProdCat = MasterData["productCategories"][number];

export function CategoriesPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [kind, setKind] = React.useState<"inventory" | "menu">("inventory");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editingInv, setEditingInv] = React.useState<InvCat | null>(null);
  const [editingProd, setEditingProd] = React.useState<ProdCat | null>(null);
  const [form, setForm] = React.useState({ name: "", slug: "", parentId: "" as string | null, categoryKind: "ingredient", active: true });

  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
  const invFn = useServerFn(upsertRestaurantInventoryCategoryFn);
  const prodFn = useServerFn(upsertRestaurantProductCategoryFn);
  const invMutation = useAdminMutation({ mutationFn: invFn, successMessage: "Category saved.", onSuccess: () => { invalidate(); setOpen(false); } });
  const prodMutation = useAdminMutation({ mutationFn: prodFn, successMessage: "Category saved.", onSuccess: () => { invalidate(); setOpen(false); } });

  const invCats: InvCat[] = data.inventoryCategories ?? [];
  const prodCats: ProdCat[] = data.productCategories ?? [];
  const list = kind === "inventory" ? invCats : prodCats;
  const filtered = list.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
  const parentOptions = list.filter((c) => c.id !== (editingInv?.id ?? editingProd?.id)).map((c) => ({ value: c.id, label: c.name }));

  function openCreate() {
    setEditingInv(null);
    setEditingProd(null);
    setForm({ name: "", slug: "", parentId: null, categoryKind: kind === "inventory" ? "ingredient" : "menu", active: true });
    setOpen(true);
  }
  function openEdit(id: string) {
    if (kind === "inventory") {
      const c = invCats.find((x) => x.id === id);
      if (!c) return;
      setEditingInv(c);
      setForm({ name: c.name, slug: c.slug, parentId: c.parent_id ?? null, categoryKind: c.kind, active: c.active });
    } else {
      const c = prodCats.find((x) => x.id === id);
      if (!c) return;
      setEditingProd(c);
      setForm({ name: c.name, slug: c.slug, parentId: c.parent_id ?? null, categoryKind: c.kind, active: c.active });
    }
    setOpen(true);
  }

  function save() {
    if (kind === "inventory") {
      invMutation.mutate({ data: { tenantId, id: editingInv?.id, name: form.name, slug: form.slug, parentId: form.parentId || null, kind: form.categoryKind, active: form.active, sortOrder: 0 } });
    } else {
      prodMutation.mutate({ data: { tenantId, id: editingProd?.id, name: form.name, slug: form.slug, parentId: form.parentId || null, kind: "menu", active: form.active, sortOrder: 0 } });
    }
  }

  const pending = invMutation.isPending || prodMutation.isPending;

  return (
    <SectionCard title="Categories" description="Inventory categories group stock items; menu categories group sellable products.">
      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg border bg-card p-1 text-sm">
          {(["inventory", "menu"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`min-h-10 rounded px-4 py-1.5 ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {k === "inventory" ? "Inventory categories" : "Menu categories"}
            </button>
          ))}
        </div>
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New category" />
        <PanelList
          items={filtered.map((c) => ({ id: c.id, title: c.name, subtitle: c.kind, active: c.active }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            if (kind === "inventory") {
              const c = invCats.find((x) => x.id === id);
              if (!c) return;
              invMutation.mutate({ data: { tenantId, id: c.id, name: c.name, slug: c.slug, parentId: c.parent_id ?? null, kind: c.kind, active, sortOrder: c.sort_order } });
            } else {
              const c = prodCats.find((x) => x.id === id);
              if (!c) return;
              prodMutation.mutate({ data: { tenantId, id: c.id, name: c.name, slug: c.slug, parentId: c.parent_id ?? null, kind: c.kind, active, sortOrder: c.sort_order } });
            }
          }}
          emptyTitle="No categories yet"
        />
      </div>

      <EntitySheet open={open} onOpenChange={setOpen} title={editingInv || editingProd ? "Edit category" : "New category"} onSubmit={save} pending={pending} disabled={!form.name || !form.slug}>
        <Field label="Name" required>
          <Input className="h-11" value={form.name} onChange={(e) => { const name = e.target.value; setForm((f) => ({ ...f, name, slug: f.slug && (editingInv || editingProd) ? f.slug : slugify(name) })); }} required />
        </Field>
        <FieldRow>
          <Field label="Slug" required>
            <Input className="h-11" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} required />
          </Field>
          {kind === "inventory" ? (
            <Field label="Kind">
              <Input className="h-11" value={form.categoryKind} onChange={(e) => setForm((f) => ({ ...f, categoryKind: e.target.value }))} />
            </Field>
          ) : null}
        </FieldRow>
        <Field label="Parent category">
          <SearchSelect options={parentOptions} value={form.parentId} onChange={(v) => setForm((f) => ({ ...f, parentId: v }))} placeholder="None" />
        </Field>
        <Field label="Active">
          <Switch checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
