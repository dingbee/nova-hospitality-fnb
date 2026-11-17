import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantStationFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData, StationRow } from "../types";

const empty = { code: "", name: "", stationType: "kitchen", targetPrepMinutes: 15, sortOrder: 0, locationId: "" as string | null };

export function StationsPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<StationRow | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantStationFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Station saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const stations: StationRow[] = data.stations ?? [];
  const filtered = stations.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const locationOptions = (data.locations ?? []).map((l) => ({ value: l.id, label: l.name }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const s = stations.find((x) => x.id === id);
    if (!s) return;
    setEditing(s);
    setForm({ code: s.code, name: s.name, stationType: s.station_type, targetPrepMinutes: s.target_prep_minutes, sortOrder: s.sort_order, locationId: s.location_id });
    setOpen(true);
  }

  function save(active: boolean) {
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        code: form.code,
        name: form.name,
        stationType: form.stationType,
        targetPrepMinutes: form.targetPrepMinutes,
        sortOrder: form.sortOrder,
        locationId: form.locationId || undefined,
        active,
      },
    });
  }

  return (
    <SectionCard title="Kitchen stations" description="Prep stations that receive fired tickets: grill, cold, bar, pass.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New station" />
        <PanelList
          items={filtered.map((s) => ({ id: s.id, title: s.name, subtitle: `${s.station_type} · target ${s.target_prep_minutes}m`, active: s.active }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const s = stations.find((x) => x.id === id);
            if (!s) return;
            mutation.mutate({
              data: { tenantId, id: s.id, code: s.code, name: s.name, stationType: s.station_type, targetPrepMinutes: s.target_prep_minutes, sortOrder: s.sort_order, locationId: s.location_id ?? undefined, active },
            });
          }}
          emptyTitle="No stations yet"
          emptyDescription="Add a station so tickets fired from the kitchen have somewhere to route."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit station" : "New station"}
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
          <Field label="Type" hint="e.g. kitchen, bar, pastry">
            <Input className="h-11" value={form.stationType} onChange={(e) => setForm((f) => ({ ...f, stationType: e.target.value }))} />
          </Field>
          <Field label="Target prep minutes">
            <QuantityField value={form.targetPrepMinutes} onChange={(v) => setForm((f) => ({ ...f, targetPrepMinutes: v }))} min={1} step={1} />
          </Field>
        </FieldRow>
        <Field label="Location">
          <SearchSelect options={locationOptions} value={form.locationId} onChange={(v) => setForm((f) => ({ ...f, locationId: v }))} placeholder="None" />
        </Field>
        <Field label="Sort order">
          <QuantityField value={form.sortOrder} onChange={(v) => setForm((f) => ({ ...f, sortOrder: v }))} step={1} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
