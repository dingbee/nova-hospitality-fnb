import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, SearchSelect } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantInventoryUnitFn } from "../../masterdata.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData } from "../types";

type Unit = MasterData["units"][number];

const empty = { code: "", name: "", dimension: "count", baseUnitId: "" as string | null, factor: 1 };

export function UnitsPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Unit | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantInventoryUnitFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Unit saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const units: Unit[] = data.units ?? [];
  const filtered = units.filter((u) => u.name.toLowerCase().includes(search.toLowerCase()) || u.code.toLowerCase().includes(search.toLowerCase()));
  const baseOptions = units.filter((u) => u.id !== editing?.id).map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const u = units.find((x) => x.id === id);
    if (!u) return;
    setEditing(u);
    setForm({ code: u.code, name: u.name, dimension: u.dimension, baseUnitId: u.base_unit_id ?? null, factor: u.factor ?? 1 });
    setOpen(true);
  }

  return (
    <SectionCard title="Units" description="Units of measure with base-unit conversion factors for stock and recipes.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New unit" />
        <PanelList
          items={filtered.map((u) => ({ id: u.id, title: `${u.name} (${u.code})`, subtitle: u.dimension, active: true }))}
          onEdit={openEdit}
          emptyTitle="No units yet"
          emptyDescription="Add base units such as kg, litre or each before adding items."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit unit" : "New unit"}
        onSubmit={() =>
          mutation.mutate({
            data: { tenantId, id: editing?.id, code: form.code, name: form.name, dimension: form.dimension, baseUnitId: form.baseUnitId || null, factor: form.factor },
          })
        }
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
        <Field label="Dimension" hint="e.g. weight, volume, count">
          <Input className="h-11" value={form.dimension} onChange={(e) => setForm((f) => ({ ...f, dimension: e.target.value }))} />
        </Field>
        <Field label="Base unit" hint="Leave empty if this is itself a base unit.">
          <SearchSelect options={baseOptions} value={form.baseUnitId} onChange={(v) => setForm((f) => ({ ...f, baseUnitId: v }))} placeholder="None" />
        </Field>
        <Field label="Factor" hint="How many base units make one of this unit.">
          <Input
            className="h-11"
            type="number"
            step="any"
            min={0.000001}
            value={form.factor}
            onChange={(e) => setForm((f) => ({ ...f, factor: parseFloat(e.target.value) || 1 }))}
          />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
