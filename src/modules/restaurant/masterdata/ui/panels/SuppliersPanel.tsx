/** Full supplier profile — core columns plus extended metadata (trading name, tax, billing/delivery, terms). */
import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/os/SectionCard";
import { EntitySheet, Field, FieldRow, QuantityField } from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantSupplierFn } from "@/modules/restaurant/suppliers/suppliers.functions";
import { PanelList, PanelToolbar } from "../shared";
import type { MasterData, SupplierRow } from "../types";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const empty = {
  name: "",
  code: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  paymentTerms: "",
  leadTimeDays: 0,
  status: "active",
  tradingName: "",
  taxNumber: "",
  billingAddress: "",
  deliveryAddress: "",
  deliveryDays: [] as string[],
  minimumOrderValue: 0,
  preferred: false,
  suppliedCategoryIds: [] as string[],
};

export function SuppliersPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SupplierRow | null>(null);
  const [form, setForm] = React.useState(empty);

  const qc = useQueryClient();
  const fn = useServerFn(upsertRestaurantSupplierFn);
  const mutation = useAdminMutation({
    mutationFn: fn,
    successMessage: "Supplier saved.",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["restaurant.masterdata", tenantId] });
      setOpen(false);
    },
  });

  const suppliers: SupplierRow[] = data.suppliers ?? [];
  const filtered = suppliers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const categoryOptions = (data.inventoryCategories ?? []).map((c) => ({ id: c.id, name: c.name }));

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(id: string) {
    const s = suppliers.find((x) => x.id === id);
    if (!s) return;
    setEditing(s);
    const meta = s.metadata ?? {};
    setForm({
      name: s.name,
      code: s.code ?? "",
      contactName: s.contact_name ?? "",
      email: s.email ?? "",
      phone: s.phone ?? "",
      address: s.address ?? "",
      paymentTerms: s.payment_terms ?? "",
      leadTimeDays: s.lead_time_days ?? 0,
      status: s.status,
      tradingName: meta.tradingName ?? "",
      taxNumber: meta.taxNumber ?? "",
      billingAddress: meta.billingAddress ?? "",
      deliveryAddress: meta.deliveryAddress ?? "",
      deliveryDays: meta.deliveryDays ?? [],
      minimumOrderValue: meta.minimumOrderValue ?? 0,
      preferred: meta.preferred ?? false,
      suppliedCategoryIds: meta.suppliedCategoryIds ?? [],
    });
    setOpen(true);
  }

  function save(status: string) {
    mutation.mutate({
      data: {
        tenantId,
        id: editing?.id,
        name: form.name,
        code: form.code || undefined,
        contactName: form.contactName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        address: form.address || undefined,
        paymentTerms: form.paymentTerms || undefined,
        leadTimeDays: form.leadTimeDays || undefined,
        status,
        tradingName: form.tradingName || undefined,
        taxNumber: form.taxNumber || undefined,
        billingAddress: form.billingAddress || undefined,
        deliveryAddress: form.deliveryAddress || undefined,
        deliveryDays: form.deliveryDays,
        minimumOrderValue: form.minimumOrderValue || undefined,
        preferred: form.preferred,
        suppliedCategoryIds: form.suppliedCategoryIds,
      },
    });
  }

  return (
    <SectionCard title="Suppliers" description="Vendors who supply purchased goods, with terms and delivery profile.">
      <div className="space-y-4">
        <PanelToolbar search={search} onSearch={setSearch} onCreate={openCreate} createLabel="New supplier" />
        <PanelList
          items={filtered.map((s) => ({
            id: s.id,
            title: s.name,
            subtitle: [s.code, s.contact_name].filter(Boolean).join(" · "),
            active: s.status === "active",
          }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const s = suppliers.find((x) => x.id === id);
            if (!s) return;
            const meta = s.metadata ?? {};
            mutation.mutate({
              data: {
                tenantId,
                id: s.id,
                name: s.name,
                code: s.code ?? undefined,
                contactName: s.contact_name ?? undefined,
                email: s.email ?? undefined,
                phone: s.phone ?? undefined,
                address: s.address ?? undefined,
                paymentTerms: s.payment_terms ?? undefined,
                leadTimeDays: s.lead_time_days ?? undefined,
                status: active ? "active" : "inactive",
                tradingName: meta.tradingName ?? undefined,
                taxNumber: meta.taxNumber ?? undefined,
                billingAddress: meta.billingAddress ?? undefined,
                deliveryAddress: meta.deliveryAddress ?? undefined,
                deliveryDays: meta.deliveryDays ?? [],
                minimumOrderValue: meta.minimumOrderValue ?? undefined,
                preferred: meta.preferred ?? false,
                suppliedCategoryIds: meta.suppliedCategoryIds ?? [],
              },
            });
          }}
          emptyTitle="No suppliers yet"
          emptyDescription="Add a supplier to start recording purchase prices and orders."
        />
      </div>

      <EntitySheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit supplier" : "New supplier"}
        wide
        onSubmit={() => save(editing?.status ?? "active")}
        pending={mutation.isPending}
        disabled={!form.name}
      >
        <FieldRow>
          <Field label="Name" required>
            <Input className="h-11" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="Trading name">
            <Input className="h-11" value={form.tradingName} onChange={(e) => setForm((f) => ({ ...f, tradingName: e.target.value }))} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Code">
            <Input className="h-11" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          </Field>
          <Field label="Tax number">
            <Input className="h-11" value={form.taxNumber} onChange={(e) => setForm((f) => ({ ...f, taxNumber: e.target.value }))} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Contact name">
            <Input className="h-11" value={form.contactName} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} />
          </Field>
          <Field label="Phone">
            <Input className="h-11" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </Field>
        </FieldRow>
        <Field label="Email">
          <Input className="h-11" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </Field>
        <Field label="Billing address">
          <Textarea value={form.billingAddress} onChange={(e) => setForm((f) => ({ ...f, billingAddress: e.target.value }))} />
        </Field>
        <Field label="Delivery address">
          <Textarea value={form.deliveryAddress} onChange={(e) => setForm((f) => ({ ...f, deliveryAddress: e.target.value }))} />
        </Field>
        <FieldRow>
          <Field label="Payment terms" hint="e.g. Net 30">
            <Input className="h-11" value={form.paymentTerms} onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </Field>
          <Field label="Lead time (days)">
            <QuantityField value={form.leadTimeDays} onChange={(v) => setForm((f) => ({ ...f, leadTimeDays: v }))} step={1} />
          </Field>
        </FieldRow>
        <Field label="Minimum order value">
          <QuantityField value={form.minimumOrderValue} onChange={(v) => setForm((f) => ({ ...f, minimumOrderValue: v }))} step={1000} />
        </Field>
        <Field label="Delivery days">
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = form.deliveryDays.includes(d);
              return (
                <Button
                  key={d}
                  type="button"
                  variant={on ? "default" : "outline"}
                  className="h-11 min-w-16 uppercase"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      deliveryDays: on ? f.deliveryDays.filter((x) => x !== d) : [...f.deliveryDays, d],
                    }))
                  }
                >
                  {d}
                </Button>
              );
            })}
          </div>
        </Field>
        <Field label="Supplied categories" hint="Inventory categories this supplier typically fulfils.">
          <div className="flex flex-wrap gap-2">
            {categoryOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No inventory categories yet.</p>
            ) : (
              categoryOptions.map((c) => {
                const on = form.suppliedCategoryIds.includes(c.id);
                return (
                  <Button
                    key={c.id}
                    type="button"
                    variant={on ? "default" : "outline"}
                    className="h-11"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        suppliedCategoryIds: on
                          ? f.suppliedCategoryIds.filter((x) => x !== c.id)
                          : [...f.suppliedCategoryIds, c.id],
                      }))
                    }
                  >
                    {c.name}
                  </Button>
                );
              })
            )}
          </div>
        </Field>
        <Field label="Preferred supplier">
          <Switch checked={form.preferred} onCheckedChange={(v) => setForm((f) => ({ ...f, preferred: v }))} />
        </Field>
      </EntitySheet>
    </SectionCard>
  );
}
