/** Shared panel for both "Outlets" (non-storage) and "Stores" (storage) tabs. */
import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertInventoryLocationFn } from "@/modules/restaurant/inventory/control.functions";
import { PanelList, PanelToolbar, slugify } from "../shared";
import type { MasterData } from "../types";

type Location = MasterData["locations"][number];

export function LocationsPanel({
  tenantId,
  data,
  mode,
}: {
  tenantId: string;
  data: MasterData;
  mode: "outlet" | "store";
}) {
  const isStorage = mode === "store";
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Location | null>(null);
  const empty = {
    propertyId: data.properties[0]?.id ?? "",
    parentId: "" as string | null,
    name: "",
    slug: "",
    code: "",
    locationType: isStorage ? "store" : "outlet",
    notes: "",
  };
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertInventoryLocationFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Location saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const locations = data.locations.filter((l) => l.is_storage === isStorage && l.name.toLowerCase().includes(search.toLowerCase()));
  const propertyOptions = data.properties.map((p) => ({ value: p.id, label: p.name }));
  const parentOptions = data.locations
    .filter((l) => l.is_storage === isStorage && l.id !== editing?.id)
    .map((l) => ({ value: l.id, label: l.name }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const l = data.locations.find((x) => x.id === id);
    if (!l) return;
    setEditing(l);
    setForm({
      propertyId: l.property_id,
      parentId: l.parent_id ?? null,
      name: l.name,
      slug: l.slug,
      code: l.code ?? "",
      locationType: l.location_type,
      notes: l.notes ?? "",
    });
    setOpen(true);
  }

  function save(active: boolean) {
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        propertyId: form.propertyId,
        parentId: form.parentId || null,
        name: form.name,
        slug: form.slug,
        code: form.code || undefined,
        locationType: form.locationType,
        isStorage,
        active,
        notes: form.notes || undefined,
      },
    });
  }

  return (
    <SectionCard
      title={isStorage ? "Stores" : "Outlets & locations"}
      description={
        isStorage
          ? "Storage locations that hold inventory: main store, bar store, walk-in fridge."
          : "Guest-facing service areas: dining rooms, bars, terraces."
      }
    >
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel={isStorage ? "New store" : "New outlet"} />
        <PanelList
          items={locations.map((l) => ({
            id: l.id,
            title: l.name,
            subtitle: `${l.location_type}${l.code ? ` · ${l.code}` : ""}`,
            active: l.status === "active",
          }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const l = data.locations.find((x) => x.id === id);
            if (!l) return;
            mutation.mutate({
              data: {
                tenantId,
                id: l.id,
                propertyId: l.property_id,
                parentId: l.parent_id ?? null,
                name: l.name,
                slug: l.slug,
                code: l.code ?? undefined,
                locationType: l.location_type,
                isStorage: l.is_storage,
                active,
                notes: l.notes ?? undefined,
              },
            });
          }}
          emptyTitle={isStorage ? "No stores yet" : "No outlets yet"}
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit location" : isStorage ? "New store" : "New outlet"}
        onSubmit={() => save(editing ? editing.status === "active" : true)}
        pending={mutation.isPending}
        disabled={!form.name || !form.slug || !form.propertyId}
      >
        <Field label="Property" required>
          <SearchSelect options={propertyOptions} value={form.propertyId} onChange={(v) => setForm((f) => ({ ...f, propertyId: v ?? "" }))} placeholder="Select property" allowClear={false} />
        </Field>
        <Field label="Name" required>
          <Input
            className="h-11"
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              setForm((f) => ({ ...f, name, slug: editing ? f.slug : slugify(name) }));
            }}
            required
          />
        </Field>
        <FieldRow>
          <Field label="Slug" required>
            <Input className="h-11" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} required />
          </Field>
          <Field label="Code">
            <Input className="h-11" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          </Field>
        </FieldRow>
        <Field label="Type">
          <Input className="h-11" value={form.locationType} onChange={(e) => setForm((f) => ({ ...f, locationType: e.target.value }))} />
        </Field>
        <Field label="Parent location">
          <SearchSelect options={parentOptions} value={form.parentId} onChange={(v) => setForm((f) => ({ ...f, parentId: v }))} placeholder="None" />
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
