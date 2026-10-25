/** Shared panel for outlets, property stores, and the optional tenant-wide main store. */
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
  mode: "outlet" | "store" | "main-store";
}) {
  const isMainStore = mode === "main-store";
  const isStorage = mode !== "outlet";
  const [search, setSearch] = React.useState("");
  const [selectedPropertyId, setSelectedPropertyId] = React.useState(data.properties[0]?.id ?? "");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Location | null>(null);
  const empty = {
    scope: (isMainStore ? "tenant" : "property") as "property" | "tenant",
    propertyId: (isMainStore ? null : selectedPropertyId) as string | null,
    parentId: null as string | null,
    name: "",
    slug: "",
    code: "",
    locationType: "store",
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

  const locations = data.locations.filter(
    (l) => (isMainStore
      ? l.scope === "tenant"
      : (l.scope === "tenant" || l.property_id === selectedPropertyId))
      && l.is_storage === isStorage
      && l.name.toLowerCase().includes(search.toLowerCase()),
  );
  const propertyOptions = data.properties.map((p) => ({ value: p.id, label: p.name }));
  const scopeOptions = [
    { value: "property", label: "Property store" },
    { value: "tenant", label: "Tenant central store" },
  ];
  const parentOptions = data.locations
    .filter((l) => form.scope === "property" && l.scope === "property" && l.property_id === form.propertyId && l.is_storage === isStorage && l.id !== editing?.id)
    .map((l) => ({ value: l.id, label: l.name }));

  function openCreate() {
    setEditing(null);
    setForm({
      ...empty,
      scope: isMainStore ? "tenant" : "property",
      propertyId: isMainStore ? null : selectedPropertyId,
      parentId: null,
    });
    setOpen(true);
  }
  function openEdit(id: string) {
    const l = data.locations.find((x) => x.id === id);
    if (!l) return;
    setEditing(l);
    setForm({
      scope: l.scope ?? "property",
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
        propertyId: form.scope === "tenant" ? null : form.propertyId,
        scope: form.scope,
        parentId: form.scope === "tenant" ? null : form.parentId || null,
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
      title={isMainStore ? "Main store" : isStorage ? "Stores" : "Outlets & locations"}
      description={
        isMainStore
          ? "Optional tenant-wide central store. It has no property assignment and can serve authorized properties through stock transfers."
          : isStorage
            ? "Property-level storage locations that hold inventory: main store, bar store, walk-in fridge."
            : "Guest-facing service areas: dining rooms, bars, terraces."
      }
    >
      <div className="space-y-4">
        {!isMainStore && (
          <Field label="Property" required>
            <SearchSelect
              options={propertyOptions}
              value={selectedPropertyId}
              onChange={(value) => {
                const nextPropertyId = value ?? "";
                setSelectedPropertyId(nextPropertyId);
                setEditing(null);
                setForm({ ...empty, propertyId: nextPropertyId, parentId: null });
                setOpen(false);
                setSearch("");
              }}
              placeholder="Select property"
              allowClear={false}
            />
          </Field>
        )}
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel={isMainStore ? "Configure main store" : isStorage ? "New store" : "New outlet"} />
        <PanelList
          items={locations.map((l) => ({
            id: l.id,
            title: l.name,
            subtitle: `${l.scope === "tenant" ? "Tenant central store · tenant-wide" : data.properties.find((p) => p.id === l.property_id)?.name ?? "Property"} · ${l.location_type}${l.code ? ` · ${l.code}` : ""}`,
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
                scope: l.scope ?? "property",
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
          emptyTitle={isMainStore ? "No tenant-wide main store configured" : isStorage ? "No stores for this property yet" : "No outlets for this property yet"}
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit location" : isMainStore ? "Configure main store" : isStorage ? "New store" : "New outlet"}
        onSubmit={() => save(editing ? editing.status === "active" : true)}
        pending={mutation.isPending}
        disabled={!form.name || !form.slug || (form.scope === "property" && !form.propertyId) || (form.scope === "tenant" && !isStorage)}
      >
        {isStorage && !isMainStore && (
          <Field label="Store scope" required>
            <SearchSelect
              options={scopeOptions}
              value={form.scope}
              onChange={(value) => setForm((f) => ({
                ...f,
                scope: value === "tenant" ? "tenant" : "property",
                propertyId: value === "tenant" ? null : (f.propertyId ?? selectedPropertyId),
                parentId: null,
              }))}
              placeholder="Choose store scope"
              allowClear={false}
            />
          </Field>
        )}
        <Field label={form.scope === "tenant" ? "Ownership" : "Property"} required={form.scope !== "tenant"}>
          {form.scope === "tenant" ? (
            <p className="rounded-md border px-3 py-2 text-sm">Tenant-level central store — no property assignment; shared through authorized stock transfers.</p>
          ) : editing ? (
            <p className="rounded-md border px-3 py-2 text-sm">
              {data.properties.find((property) => property.id === form.propertyId)?.name ?? "Selected property"}
            </p>
          ) : (
            <SearchSelect
              options={propertyOptions}
              value={form.propertyId ?? ""}
              onChange={(value) => setForm((f) => ({ ...f, propertyId: value ?? null, parentId: null }))}
              placeholder="Select property"
              allowClear={false}
            />
          )}
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
        {form.scope === "property" && (
          <Field label="Parent location">
            <SearchSelect options={parentOptions} value={form.parentId} onChange={(v) => setForm((f) => ({ ...f, parentId: v }))} placeholder="None" />
          </Field>
        )}
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
