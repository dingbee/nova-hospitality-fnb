import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantServicePeriodFn } from "@/modules/restaurant/sales/sales.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData, ServicePeriodRow } from "../types";

const empty = { code: "", name: "", startTime: "00:00", endTime: "23:59", sortOrder: 0, locationId: "" as string | null };

export function ServicePeriodsPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ServicePeriodRow | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantServicePeriodFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Service period saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const periods: ServicePeriodRow[] = data.servicePeriods ?? [];
  const filtered = periods.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  const locationOptions = (data.locations ?? []).map((l) => ({ value: l.id, label: l.name }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const p = periods.find((x) => x.id === id);
    if (!p) return;
    setEditing(p);
    setForm({ code: p.code, name: p.name, startTime: p.start_time, endTime: p.end_time, sortOrder: p.sort_order, locationId: p.location_id });
    setOpen(true);
  }

  function save(active: boolean) {
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        code: form.code,
        name: form.name,
        startTime: form.startTime,
        endTime: form.endTime,
        sortOrder: form.sortOrder,
        locationId: form.locationId || undefined,
        active,
      },
    });
  }

  return (
    <SectionCard title="Service periods" description="Breakfast, lunch, dinner — used to bucket sales and demand patterns.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New service period" />
        <PanelList
          items={filtered.map((p) => ({ id: p.id, title: p.name, subtitle: `${p.start_time}–${p.end_time}`, active: p.active }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const p = periods.find((x) => x.id === id);
            if (!p) return;
            mutation.mutate({
              data: { tenantId, id: p.id, code: p.code, name: p.name, startTime: p.start_time, endTime: p.end_time, sortOrder: p.sort_order, locationId: p.location_id ?? undefined, active },
            });
          }}
          emptyTitle="No service periods yet"
          emptyDescription="Add breakfast, lunch and dinner windows to bucket sales by daypart."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit service period" : "New service period"}
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
          <Field label="Start time" required>
            <Input className="h-11" type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} required />
          </Field>
          <Field label="End time" required>
            <Input className="h-11" type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} required />
          </Field>
        </FieldRow>
        <Field label="Location" hint="Leave empty to apply property-wide.">
          <SearchSelect options={locationOptions} value={form.locationId} onChange={(v) => setForm((f) => ({ ...f, locationId: v }))} placeholder="None" />
        </Field>
        <Field label="Sort order">
          <QuantityField value={form.sortOrder} onChange={(v) => setForm((f) => ({ ...f, sortOrder: v }))} step={1} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
