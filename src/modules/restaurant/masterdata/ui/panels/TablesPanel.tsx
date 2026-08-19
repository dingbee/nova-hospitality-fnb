import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantTableFn } from "@/modules/restaurant/sales/sales.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData, TableRow } from "../types";

const STATUSES = ["available", "occupied", "reserved", "cleaning", "out_of_service"] as const;

const empty = { code: "", name: "", zone: "", seats: 2, status: "available" as string, locationId: "" as string | null };

export function TablesPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TableRow | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantTableFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Table saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const tables: TableRow[] = data.tables ?? [];
  const filtered = tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.code.toLowerCase().includes(search.toLowerCase()));
  const locationOptions = (data.locations ?? []).map((l) => ({ value: l.id, label: l.name }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const t = tables.find((x) => x.id === id);
    if (!t) return;
    setEditing(t);
    setForm({ code: t.code, name: t.name, zone: t.zone ?? "", seats: t.seats, status: t.status, locationId: t.location_id });
    setOpen(true);
  }

  function save(active: boolean) {
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        code: form.code,
        name: form.name,
        zone: form.zone || undefined,
        seats: form.seats,
        status: form.status as (typeof STATUSES)[number],
        locationId: form.locationId || undefined,
        active,
      },
    });
  }

  return (
    <SectionCard title="Tables" description="Guest-facing seating used by the POS floor plan and order assignment.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New table" />
        <PanelList
          items={filtered.map((t) => ({ id: t.id, title: `${t.name} (${t.code})`, subtitle: `${t.zone ?? "No zone"} · ${t.seats} seats · ${t.status}`, active: t.active }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const t = tables.find((x) => x.id === id);
            if (!t) return;
            mutation.mutate({
              data: { tenantId, id: t.id, code: t.code, name: t.name, zone: t.zone ?? undefined, seats: t.seats, status: t.status as (typeof STATUSES)[number], locationId: t.location_id ?? undefined, active },
            });
          }}
          emptyTitle="No tables yet"
          emptyDescription="Add tables so the POS floor plan and order flow have somewhere to assign guests."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit table" : "New table"}
        onSubmit={() => save(editing ? editing.active : true)}
        pending={mutation.isPending}
        disabled={!form.code || !form.name}
      >
        <FieldRow>
          <Field label="Code" required>
            <Input className="h-11" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} required />
          </Field>
          <Field label="Name" required>
            <Input className="h-11" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Zone">
            <Input className="h-11" value={form.zone} onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))} />
          </Field>
          <Field label="Seats">
            <QuantityField value={form.seats} onChange={(v) => setForm((f) => ({ ...f, seats: v }))} min={1} max={60} step={1} />
          </Field>
        </FieldRow>
        <Field label="Location">
          <SearchSelect options={locationOptions} value={form.locationId} onChange={(v) => setForm((f) => ({ ...f, locationId: v }))} placeholder="None" />
        </Field>
        <Field label="Status">
          <SearchSelect
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            value={form.status}
            onChange={(v) => setForm((f) => ({ ...f, status: v ?? "available" }))}
            placeholder="Status"
            allowClear={false}
          />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
