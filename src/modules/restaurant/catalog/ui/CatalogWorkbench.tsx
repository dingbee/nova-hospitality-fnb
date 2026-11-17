/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * F&B Master Catalog — the SKU spine of the operation.
 *
 * This screen shows identity and configuration only: what the business buys,
 * stores and consumes. Balances, prices, recipes and menu items live elsewhere
 * and deliberately do not appear here.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip } from "@/components/os/StatusChip";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { CATALOG_DOMAIN_LABELS } from "../parse";
import {
  importMasterCatalogFn,
  listCatalogImportBatchesFn,
  listCatalogReviewQueueFn,
  listMasterCatalogFn,
  resolveCatalogReviewRowFn,
} from "../catalog.functions";

const TABS = [
  { id: "catalog", label: "Catalog" },
  { id: "quality", label: "Data quality" },
  { id: "imports", label: "Imports" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  return (
    <select
      className="h-10 rounded-md border bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CatalogWorkbench() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const qc = useQueryClient();

  const [tab, setTab] = React.useState<TabId>("catalog");
  const [search, setSearch] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [subcategory, setSubcategory] = React.useState("");
  const [dataStatus, setDataStatus] = React.useState("");
  const [status, setStatus] = React.useState("active");
  const [detail, setDetail] = React.useState<any | null>(null);

  const listFn = useServerFn(listMasterCatalogFn);
  const batchesFn = useServerFn(listCatalogImportBatchesFn);
  const queueFn = useServerFn(listCatalogReviewQueueFn);
  const importFn = useServerFn(importMasterCatalogFn);
  const resolveFn = useServerFn(resolveCatalogReviewRowFn);

  const catalog = useQuery({
    queryKey: ["restaurant.catalog", tenantId, { search, domain, categoryId, subcategory, dataStatus, status }],
    enabled: Boolean(tenantId),
    queryFn: () =>
      listFn({
        data: {
          tenantId: tenantId!,
          search: search || undefined,
          domain: domain || undefined,
          categoryId: categoryId || undefined,
          subcategory: subcategory || undefined,
          dataStatus: (dataStatus || undefined) as any,
          status: (status || undefined) as any,
          limit: 1000,
        },
      }),
  });

  const batches = useQuery({
    queryKey: ["restaurant.catalog.batches", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => batchesFn({ data: { tenantId: tenantId! } }),
  });

  const queue = useQuery({
    queryKey: ["restaurant.catalog.queue", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => queueFn({ data: { tenantId: tenantId! } }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.catalog"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.catalog.batches", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.catalog.queue", tenantId] });
  };

  const runImport = useAdminMutation({
    mutationFn: () => importFn({ data: { tenantId: tenantId! } }),
    successMessage: "Master catalog import completed.",
    onSuccess: invalidate,
  });
  const resolveRow = useAdminMutation({
    mutationFn: (rowId: string) => resolveFn({ data: { tenantId: tenantId!, rowId } }),
    successMessage: "Marked as reviewed.",
    onSuccess: invalidate,
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const items: any[] = catalog.data?.items ?? [];
  const categories: any[] = catalog.data?.categories ?? [];
  const units: any[] = catalog.data?.units ?? [];
  const unitById = new Map(units.map((u) => [u.id, u]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const subcategories = [...new Set(items.map((i) => i.subcategory).filter(Boolean))].sort();
  const unconfirmed = items.filter((i) => i.data_status === "UNCONFIRMED").length;
  const reviewRows: any[] = queue.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="F&B Master Catalog"
        description="SKU → inventory → recipe → menu → order → consumption → cost. Identity and configuration only: no balances, prices, recipes or menu items are created here."
        actions={
          <Button onClick={() => runImport.mutate(undefined as never)} disabled={runImport.isPending || !tenantId}>
            {runImport.isPending ? "Importing…" : "Run master catalog import"}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Catalog SKUs" value={String(items.length)} />
        <StatCard label="Unconfirmed" value={String(unconfirmed)} />
        <StatCard label="Awaiting review" value={String(reviewRows.length)} />
      </div>

      <nav className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-2 ${tab === t.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "catalog" && (
        <SectionCard title="Catalog" description="Search by SKU or name and filter by domain, category, subcategory and data quality.">
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              className="h-10 w-56"
              placeholder="Search SKU or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              value={domain}
              onChange={setDomain}
              placeholder="All domains"
              options={Object.entries(CATALOG_DOMAIN_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Select
              value={categoryId}
              onChange={setCategoryId}
              placeholder="All categories"
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
            <Select
              value={subcategory}
              onChange={setSubcategory}
              placeholder="All subcategories"
              options={subcategories.map((s) => ({ value: s as string, label: s as string }))}
            />
            <Select
              value={dataStatus}
              onChange={setDataStatus}
              placeholder="Confirmed & unconfirmed"
              options={[
                { value: "CONFIRMED", label: "Confirmed" },
                { value: "UNCONFIRMED", label: "Unconfirmed" },
              ]}
            />
            <Select
              value={status}
              onChange={setStatus}
              placeholder="All statuses"
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Archived" },
              ]}
            />
          </div>

          {items.length === 0 ? (
            <EmptyState
              title="No catalog items"
              description="Run the master catalog import to establish the SKU spine, or adjust your filters."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3">Domain</th>
                    <th className="py-2 pr-3">Category</th>
                    <th className="py-2 pr-3">Purchase unit</th>
                    <th className="py-2 pr-3">Pack size</th>
                    <th className="py-2 pr-3">Base unit</th>
                    <th className="py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr
                      key={i.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/50"
                      onClick={() => setDetail(i)}
                    >
                      <td className="py-2 pr-3 font-mono text-xs">{i.sku}</td>
                      <td className="py-2 pr-3">{i.name}</td>
                      <td className="py-2 pr-3">{CATALOG_DOMAIN_LABELS[i.domain] ?? i.domain}</td>
                      <td className="py-2 pr-3">{categoryById.get(i.category_id)?.name ?? "—"}</td>
                      <td className="py-2 pr-3">{unitById.get(i.purchase_unit_id)?.name ?? "—"}</td>
                      <td className="py-2 pr-3">{i.pack_label ?? "—"}</td>
                      <td className="py-2 pr-3">{unitById.get(i.unit_id)?.code ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <StatusChip tone={i.data_status === "CONFIRMED" ? "success" : "warning"}>
                          {i.data_status === "CONFIRMED" ? "Confirmed" : "Unconfirmed"}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {tab === "quality" && (
        <SectionCard
          title="Data quality queue"
          description="Rows the import could not resolve without guessing, plus any SKU conflicts with existing records. Source provenance is never altered."
        >
          {reviewRows.length === 0 ? (
            <EmptyState title="Nothing to review" description="Every imported row resolved cleanly." />
          ) : (
            <ul className="divide-y">
              {reviewRows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      {r.sku} · row {r.source_row} · {r.result}
                    </p>
                    <p className="font-medium">{r.name}</p>
                    {r.message ? <p className="text-sm text-muted-foreground">{r.message}</p> : null}
                    {(r.source_values?.issues ?? []).map((issue: string) => (
                      <p key={issue} className="text-sm text-muted-foreground">
                        • {issue}
                      </p>
                    ))}
                    {(r.conflicts ?? []).map((c: any) => (
                      <p key={c.field} className="text-sm text-muted-foreground">
                        • {c.field}: existing “{String(c.existing ?? "—")}” vs incoming “{String(c.incoming ?? "—")}”
                      </p>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => resolveRow.mutate(r.id)} disabled={resolveRow.isPending}>
                    Mark reviewed
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "imports" && (
        <SectionCard title="Import history" description="Every catalog import is auditable: source file, who ran it, when, and the outcome of each row.">
          {(batches.data ?? []).length === 0 ? (
            <EmptyState title="No imports yet" description="Run the master catalog import to create the first batch." />
          ) : (
            <ul className="divide-y">
              {(batches.data ?? []).map((b: any) => (
                <li key={b.id} className="py-3">
                  <p className="font-medium">{b.source_file}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(b.imported_at).toLocaleString()} · {b.total_rows} rows · created {b.created_count} ·
                    unchanged {b.unchanged_count} · updated {b.updated_count} · conflicts {b.conflict_count} ·
                    unconfirmed {b.unconfirmed_count} · skipped {b.skipped_count} · errors {b.error_count}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <Sheet open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
          </SheetHeader>
          {detail ? (
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ["SKU", detail.sku],
                ["Domain", CATALOG_DOMAIN_LABELS[detail.domain] ?? detail.domain],
                ["Category", categoryById.get(detail.category_id)?.name ?? "—"],
                ["Subcategory", detail.subcategory ?? "—"],
                ["Purchase unit", unitById.get(detail.purchase_unit_id)?.name ?? "—"],
                ["Pack size", detail.pack_label ?? "—"],
                ["Pack size (base units)", detail.pack_size ?? "—"],
                ["Base unit", unitById.get(detail.unit_id)?.name ?? "—"],
                ["Data status", detail.data_status],
                ["Item type", detail.item_type],
                ["Status", detail.status],
                ["Source", detail.source ?? "—"],
                ["Source row", detail.source_row ?? "—"],
                ["Created", new Date(detail.created_at).toLocaleString()],
                ["Updated", new Date(detail.updated_at).toLocaleString()],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
