/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Document Centre — one place to find, preview, print and export every
 * operational document, without needing to know which module produced it.
 *
 * Documents are previewed exactly as they print. Dataset exports state their
 * period and filters on a metadata sheet so a spreadsheet can never be
 * mistaken for a different period.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Download, FileSpreadsheet, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { StatusChip } from "@/components/os/StatusChip";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { DOCUMENT_GROUPS, DOCUMENT_TYPE_LIST, type DocumentGroup, type DocumentTypeId } from "../core/registry";
import { DocumentView } from "../rendering/DocumentView";
import { DocumentActions } from "./DocumentActions";
import { downloadWorkbook } from "../exports/download";
import {
  buildRestaurantDatasetFn,
  listRestaurantDocumentEventsFn,
  recordRestaurantDocumentEventFn,
  renderRestaurantDocumentFn,
  searchRestaurantDocumentsFn,
} from "../documents.functions";
import type { ExportWorkbook } from "../exports/model";
import type { RestaurantDocument } from "../core/types";

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);

export function DocumentCentre() {
  const { data: workspace, isLoading } = useRestaurantWorkspace();
  const tenantId = workspace?.tenant?.id ?? "";

  const searchFn = useServerFn(searchRestaurantDocumentsFn);
  const renderFn = useServerFn(renderRestaurantDocumentFn);
  const datasetFn = useServerFn(buildRestaurantDatasetFn);
  const eventsFn = useServerFn(listRestaurantDocumentEventsFn);
  const auditFn = useServerFn(recordRestaurantDocumentEventFn);

  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<DocumentGroup | "all">("all");
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [selected, setSelected] = useState<{ type: DocumentTypeId; recordId: string; number: string | null } | null>(
    null,
  );
  const [exporting, setExporting] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ["restaurant.documents.search", tenantId, query, group],
    enabled: Boolean(tenantId),
    queryFn: () =>
      searchFn({ data: { tenantId, query, group: group === "all" ? undefined : group, limit: 40 } }) as any,
  });

  const preview = useQuery({
    queryKey: ["restaurant.documents.render", tenantId, selected?.type, selected?.recordId],
    enabled: Boolean(tenantId && selected),
    queryFn: () =>
      renderFn({ data: { tenantId, type: selected!.type, recordId: selected!.recordId } }) as any as Promise<
        RestaurantDocument
      >,
  });

  const events = useQuery({
    queryKey: ["restaurant.documents.events", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => eventsFn({ data: { tenantId, limit: 40 } }) as any,
  });

  async function exportDataset(type: DocumentTypeId, format: "csv" | "xlsx" | "json") {
    setExporting(`${type}.${format}`);
    try {
      const workbook = (await datasetFn({ data: { tenantId, type, from, to, limit: 2000 } })) as any as ExportWorkbook;
      await downloadWorkbook(workbook, format);
      await auditFn({
        data: { tenantId, type, action: "exported", format, metadata: { from, to } },
      }).catch(() => undefined);
      toast.success(`${workbook.title} exported (${workbook.metadata.rowCount ?? 0} rows).`);
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed.");
    } finally {
      setExporting(null);
    }
  }

  if (isLoading) return <LoadingState />;
  if (!tenantId) {
    return (
      <EmptyState
        title="No restaurant workspace"
        description="Set up a restaurant tenant before opening the Document Centre."
      />
    );
  }

  const exports = DOCUMENT_TYPE_LIST.filter((d) => d.kind === "export");
  const documents = DOCUMENT_TYPE_LIST.filter((d) => d.kind === "document");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Document Centre"
        description="Find, preview, print and export every operational document. Every action is recorded against the record it came from."
      />

      <SectionCard title="Find a document">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="doc-search">Document number</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input
                id="doc-search"
                className="pl-8"
                placeholder="PO-2026-000142, GRN, RCP…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="doc-group">Area</Label>
            <select
              id="doc-group"
              className="h-10 rounded-md border border-border bg-background px-3 text-sm"
              value={group}
              onChange={(e) => setGroup(e.target.value as DocumentGroup | "all")}
            >
              <option value="all">All areas</option>
              {DOCUMENT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {results.isLoading && <LoadingState />}
          {!results.isLoading && !(results.data as any[])?.length && (
            <p className="text-sm text-muted-foreground">No documents match that search.</p>
          )}
          {((results.data as any[]) ?? []).map((r) => (
            <button
              key={`${r.type}-${r.recordId}`}
              onClick={() => setSelected({ type: r.type, recordId: r.recordId, number: r.number })}
              className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left transition hover:bg-muted ${
                selected?.recordId === r.recordId ? "border-primary" : ""
              }`}
            >
              <div>
                <div className="font-medium">{r.number ?? "Unnumbered"}</div>
                <div className="text-xs text-muted-foreground">
                  {r.label} · {r.date ? String(r.date).slice(0, 10) : "no date"}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {r.amount != null && (
                  <span className="tabular-nums">
                    {r.currency ?? ""} {Number(r.amount).toFixed(2)}
                  </span>
                )}
                {r.status && <StatusChip tone="neutral">{String(r.status)}</StatusChip>}
              </div>
            </button>
          ))}
        </div>
      </SectionCard>

      {selected && (
        <SectionCard
          title={selected.number ?? "Document"}
          description="Previewed exactly as it prints."
          actions={
            <DocumentActions
              tenantId={tenantId}
              type={selected.type}
              recordId={selected.recordId}
              documentNumber={selected.number}
              doc={(preview.data as RestaurantDocument | undefined) ?? null}
            />
          }
        >
          {preview.isLoading && <LoadingState />}
          {preview.error && (
            <p className="text-sm text-destructive">{(preview.error as Error).message}</p>
          )}
          {preview.data && <DocumentView doc={preview.data as RestaurantDocument} />}
        </SectionCard>
      )}

      <SectionCard title="Dataset exports" description="Raw data for analysis. Period and filters travel with the file.">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="doc-from">From</Label>
            <Input id="doc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="doc-to">To</Label>
            <Input id="doc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {exports.map((d) => (
            <div key={d.id} className="rounded-lg border p-3">
              <div className="font-medium">{d.label}</div>
              <p className="mb-2 text-xs text-muted-foreground">{d.description}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={exporting !== null}
                  onClick={() => exportDataset(d.id, "xlsx")}
                >
                  <FileSpreadsheet className="mr-1 size-4" /> Excel
                </Button>
                <Button size="sm" variant="outline" disabled={exporting !== null} onClick={() => exportDataset(d.id, "csv")}>
                  <Download className="mr-1 size-4" /> CSV
                </Button>
                <Button size="sm" variant="ghost" disabled={exporting !== null} onClick={() => exportDataset(d.id, "json")}>
                  JSON
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Document types" description="Every document this system can produce, and where its record lives.">
        <div className="grid gap-2 md:grid-cols-2">
          {documents.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <div>
                <div className="font-medium">{d.label}</div>
                <div className="text-xs text-muted-foreground">{d.description}</div>
              </div>
              {d.workflowRoute && (
                <Link to={d.workflowRoute as any} className="shrink-0 text-xs underline">
                  Open
                </Link>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Recent document activity" description="Who produced what, when, and in which format.">
        <div className="space-y-1 text-sm">
          {((events.data as any[]) ?? []).map((e) => (
            <div key={e.id} className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0">
              <span>
                {e.document_number ?? e.document_type} · <span className="text-muted-foreground">{e.action}</span>
                {e.format ? ` (${e.format})` : ""}
              </span>
              <span className="text-xs text-muted-foreground">{String(e.created_at).replace("T", " ").slice(0, 19)}</span>
            </div>
          ))}
          {!((events.data as any[]) ?? []).length && (
            <p className="text-muted-foreground">No documents have been produced yet.</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}