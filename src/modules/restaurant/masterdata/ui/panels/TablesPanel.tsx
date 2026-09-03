import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { QrCode, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/os/SectionCard";
import {
  EntitySheet,
  Field,
  FieldRow,
  QuantityField,
  SearchSelect,
} from "@/modules/restaurant/ui/forms";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { upsertRestaurantTableFn } from "@/modules/restaurant/sales/sales.functions";
import { PanelList, PanelToolbar } from "../shared";
import { buildTableQrCard, buildTableQrCards, type TableQrCard } from "../../qr";
import { buildQrPackPdf } from "../qrRender";
import { TableQrDialog } from "./TableQrDialog";
import type { MasterData, TableRow } from "../types";

const STATUSES = ["available", "occupied", "reserved", "cleaning", "out_of_service"] as const;

const empty = {
  code: "",
  name: "",
  zone: "",
  seats: 2,
  status: "available" as string,
  locationId: "" as string | null,
};

export function TablesPanel({ tenantId, data }: { tenantId: string; data: MasterData }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TableRow | null>(null);
  const [form, setForm] = React.useState(empty);
  const [qrCard, setQrCard] = React.useState<TableQrCard | null>(null);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);

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
  const filtered = tables.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.code.toLowerCase().includes(search.toLowerCase()),
  );
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
    setForm({
      code: t.code,
      name: t.name,
      zone: t.zone ?? "",
      seats: t.seats,
      status: t.status,
      locationId: t.location_id,
    });
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

  /** Every active table becomes QR-ready the instant it's created — no separate setup step (spec section 9). Nothing here reads from the server: the guest URL is derived entirely from the table id and business branding this screen already has loaded. */
  function openQr(id: string) {
    const t = tables.find((x) => x.id === id);
    if (!t) return;
    setQrCard(buildTableQrCard(data.tenant, t, window.location.origin));
    setQrOpen(true);
  }

  async function downloadAllQr() {
    setBulkPending(true);
    setBulkError(null);
    try {
      const cards = buildTableQrCards(data.tenant, tables, window.location.origin);
      const doc = await buildQrPackPdf(cards);
      const businessSlug = (data.tenant?.name ?? "restaurant")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      doc.save(`${businessSlug}-table-qr-codes.pdf`);
    } catch {
      setBulkError("Could not generate the QR pack right now. Please try again.");
    } finally {
      setBulkPending(false);
    }
  }

  const activeTableCount = tables.filter((t) => t.active).length;

  return (
    <SectionCard
      title="Tables"
      description="Guest-facing seating used by the POS floor plan and order assignment."
    >
      <div className="space-y-4">
        <PanelToolbar
          search={search}
          onSearch={setSearch}
          onCreate={openCreate}
          createLabel="New table"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Every active table has a permanent Guest QR — print it and place it on the table.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={bulkPending || activeTableCount === 0}
            onClick={downloadAllQr}
          >
            {bulkPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
            ) : (
              <QrCode className="mr-1 size-4" aria-hidden />
            )}
            Download all QR codes
          </Button>
        </div>
        {bulkError ? <p className="text-xs text-destructive">{bulkError}</p> : null}
        <PanelList
          items={filtered.map((t) => ({
            id: t.id,
            title: `${t.name} (${t.code})`,
            subtitle: `${t.zone ?? "No zone"} · ${t.seats} seats · ${t.status}`,
            active: t.active,
          }))}
          onEdit={openEdit}
          onToggleActive={(id, active) => {
            const t = tables.find((x) => x.id === id);
            if (!t) return;
            mutation.mutate({
              data: {
                tenantId,
                id: t.id,
                code: t.code,
                name: t.name,
                zone: t.zone ?? undefined,
                seats: t.seats,
                status: t.status as (typeof STATUSES)[number],
                locationId: t.location_id ?? undefined,
                active,
              },
            });
          }}
          renderRowExtra={(id) => {
            const t = tables.find((x) => x.id === id);
            if (!t?.active) return null;
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  openQr(id);
                }}
              >
                <QrCode className="mr-1 size-4" aria-hidden />
                Guest QR
              </Button>
            );
          }}
          emptyTitle="No tables yet"
          emptyDescription="Add tables so the POS floor plan and order flow have somewhere to assign guests."
        />
      </div>

      <TableQrDialog card={qrCard} open={qrOpen} onOpenChange={setQrOpen} />

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
            <Input
              className="h-11"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              required
            />
          </Field>
          <Field label="Name" required>
            <Input
              className="h-11"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Zone">
            <Input
              className="h-11"
              value={form.zone}
              onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))}
            />
          </Field>
          <Field label="Seats">
            <QuantityField
              value={form.seats}
              onChange={(v) => setForm((f) => ({ ...f, seats: v }))}
              min={1}
              max={60}
              step={1}
            />
          </Field>
        </FieldRow>
        <Field label="Location">
          <SearchSelect
            options={locationOptions}
            value={form.locationId}
            onChange={(v) => setForm((f) => ({ ...f, locationId: v }))}
            placeholder="None"
          />
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
