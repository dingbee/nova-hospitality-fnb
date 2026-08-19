import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantPropertyFn } from "../../masterdata.functions";
import { PanelList, PanelToolbar, slugify } from "../shared";
import type { MasterData } from "../types";

type Property = MasterData["properties"][number];

import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from "@/modules/restaurant/core/product";

const EMPTY = { name: "", slug: "", timezone: DEFAULT_TIMEZONE, currency: DEFAULT_CURRENCY, status: "active" };

export function PropertiesPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Property | null>(null);
  const [form, setForm] = React.useState(EMPTY);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantPropertyFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Property saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const properties = data.properties.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  function openEdit(id: string) {
    const p = data.properties.find((x) => x.id === id);
    if (!p) return;
    setEditing(p);
    setForm({ name: p.name, slug: p.slug, timezone: p.timezone, currency: p.currency, status: p.status });
    setOpen(true);
  }

  return (
    <SectionCard title="Properties" description="Outlets, hotels or venues that belong to this tenant.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New property" />
        <PanelList
          items={properties.map((p) => ({ id: p.id, title: p.name, subtitle: `${p.slug} · ${p.currency}`, active: p.status === "active" }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const p = data.properties.find((x) => x.id === id);
            if (!p) return;
            mutation.mutate({
              data: { tenantId, id: p.id, name: p.name, slug: p.slug, timezone: p.timezone, currency: p.currency, status: active ? "active" : "inactive" },
            });
          }}
          emptyTitle="No properties yet"
          emptyDescription="Add the first property to unlock outlets, stores and menus."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit property" : "New property"}
        onSubmit={() =>
          mutation.mutate({
            data: { tenantId, id: editing?.id, name: form.name, slug: form.slug, timezone: form.timezone, currency: form.currency, status: form.status },
          })
        }
        pending={mutation.isPending}
        disabled={!form.name || !form.slug}
      >
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
        <Field label="Slug" required hint="Lowercase, hyphenated.">
          <Input className="h-11" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} required />
        </Field>
        <FieldRow>
          <Field label="Timezone" required>
            <Input className="h-11" value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} required />
          </Field>
          <Field label="Currency" required>
            <Input className="h-11" maxLength={3} value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} required />
          </Field>
        </FieldRow>
        <Field label="Active">
          <Switch checked={form.status === "active"} onCheckedChange={(v) => setForm((f) => ({ ...f, status: v ? "active" : "inactive" }))} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
