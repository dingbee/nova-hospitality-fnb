/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Import Studio — two paths into LexiBite.
 *
 * RECOMMENDED: download the LexiBite Import Template, fill it in with
 * restaurant-native terms and stable codes (no database IDs, no fuzzy
 * matching needed), upload it back — LexiBite Intelligence recognises it
 * deterministically and imports it end to end. ADVANCED: bring an existing,
 * arbitrary spreadsheet — LexiBite Intelligence understands its structure,
 * maps it, matches it against what already exists, and you review before
 * anything becomes real. Both paths ride the same staging/review/commit
 * architecture below — nothing here ever writes a canonical table directly;
 * every approved row goes through the same service functions manual entry
 * uses (see import.server.ts / template-import.server.ts).
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import {
  analyzeLexibiteTemplateUploadFn,
  bulkDecideStagedRecordsFn,
  commitImportWorkspaceFn,
  commitLexibiteTemplateImportFn,
  confirmImportMappingFn,
  createImportWorkspaceFn,
  decideStagedRecordFn,
  getImportWorkspaceFn,
  listImportWorkspacesFn,
  listStagedRecordsFn,
  parseImportSourceFn,
  suggestImportMappingFn,
  uploadImportSourceFn,
} from "../import.functions";
import { listRestaurantInventoryCategoriesFn } from "../../masterdata/masterdata.functions";
import {
  listRestaurantMenuItemsFn,
  listRestaurantMenusFn,
} from "../../menu/menu.functions";
import {
  CANONICAL_FIELDS,
  IMPORT_DOMAINS,
  IMPORT_DOMAIN_LABELS,
  classifySheetIdentity,
  type ImportDomain,
} from "../domains";
import { downloadLexibiteTemplate } from "../template-xlsx";
import type { TemplateIssue } from "../template-import.server";

/**
 * Customer-facing status labels only — never a raw match_status/severity
 * value or a numeric confidence score (see the LexiBite import upgrade
 * spec, Part 11 / Part 20: no technical internals, no percentages).
 */
const SEVERITY_META: Record<string, { label: string; tone: StatusTone; icon: string }> = {
  cannot_map: { label: "Cannot determine", tone: "danger", icon: "\u{1F534}" },
  ambiguous_match: { label: "Needs review", tone: "warning", icon: "\u{1F7E0}" },
  missing_field: { label: "Needs review", tone: "warning", icon: "\u{1F7E1}" },
  new_entity: { label: "Ready", tone: "info", icon: "\u{1F535}" },
  auto_ok: { label: "Ready", tone: "success", icon: "\u{1F7E2}" },
};

/** A domain guess's confidence, translated to language a customer reads instead of a percentage. */
function domainGuessLabel(confidence: number): string {
  if (confidence >= 0.7) return "Likely match";
  if (confidence >= 0.4) return "Possible match";
  return "Weak match";
}

/** A sheet whose name alone strongly suggests it isn't operational data — never auto-imported, only flagged for a human to confirm or override. */
const NON_OPERATIONAL_SHEET_NAME =
  /read ?me|instructions?|scenarios?|examples?|\bnotes?\b|documentation|test ?data/i;
function looksNonOperational(sheetName: string): boolean {
  return NON_OPERATIONAL_SHEET_NAME.test(sheetName);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function kindForFile(file: File): "xlsx" | "csv" | "pdf" | "image" | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "xlsx";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".pdf")) return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

type ImportPath = "template" | "advanced" | null;

export function ImportStudio() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [path, setPath] = useState<ImportPath>(null);

  if (!tenantId) {
    return (
      <SectionCard title="No restaurant workspace">
        <EmptyState
          title="No tenant"
          description="Set up a restaurant tenant to use Import Studio."
        />
      </SectionCard>
    );
  }

  const reset = () => {
    setWorkspaceId(null);
    setPath(null);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import Studio"
        description="Bring your restaurant data into LexiBite. Use the LexiBite template for the fastest, most reliable import, or bring an existing spreadsheet and let LexiBite Intelligence understand it for you."
      />
      {workspaceId ? (
        <WorkspaceDetail tenantId={tenantId} workspaceId={workspaceId} onBack={reset} />
      ) : path === "template" ? (
        <TemplateImportFlow
          tenantId={tenantId}
          onBack={() => setPath(null)}
          onImported={setWorkspaceId}
          onSwitchToAdvanced={() => setPath("advanced")}
        />
      ) : path === "advanced" ? (
        <div className="space-y-4">
          <Button variant="outline" size="sm" onClick={() => setPath(null)}>
            ← Choose a different way to import
          </Button>
          <WorkspaceList tenantId={tenantId} onSelect={setWorkspaceId} />
        </div>
      ) : (
        <ImportPathChooser
          onChooseTemplate={() => setPath("template")}
          onChooseAdvanced={() => setPath("advanced")}
        />
      )}
    </div>
  );
}

/* ---------------- Path chooser ---------------- */

function ImportPathChooser({
  onChooseTemplate,
  onChooseAdvanced,
}: {
  onChooseTemplate: () => void;
  onChooseAdvanced: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Use the LexiBite template" description="Recommended">
        <ul className="space-y-1.5 text-sm">
          <li>✓ Clear restaurant-friendly fields</li>
          <li>✓ No technical IDs</li>
          <li>✓ Relationships are handled automatically</li>
          <li>✓ Built-in examples</li>
          <li>✓ Faster validation</li>
          <li>✓ Highest-confidence import</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="h-11" onClick={() => downloadLexibiteTemplate()}>
            Download LexiBite Import Template
          </Button>
          <Button className="h-11" variant="outline" onClick={onChooseTemplate}>
            I already have the template
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Import existing data" description="Advanced · LexiBite Intelligence">
        <ul className="space-y-1.5 text-sm">
          <li>✓ Understands unfamiliar spreadsheets</li>
          <li>✓ Detects menus, inventory, suppliers, recipes</li>
          <li>✓ Finds likely matches</li>
          <li>✓ Explains ambiguous records</li>
          <li>✓ Identifies missing relationships</li>
          <li>✓ Nothing becomes real until you approve it</li>
        </ul>
        <div className="mt-4">
          <Button className="h-11" variant="outline" onClick={onChooseAdvanced}>
            Start Advanced Import
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

/* ---------------- Template path ---------------- */

function TemplateImportFlow({
  tenantId,
  onBack,
  onImported,
  onSwitchToAdvanced,
}: {
  tenantId: string;
  onBack: () => void;
  onImported: (workspaceId: string) => void;
  onSwitchToAdvanced: () => void;
}) {
  const analyzeFn = useServerFn(analyzeLexibiteTemplateUploadFn);
  const commitFn = useServerFn(commitLexibiteTemplateImportFn);
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);

  const analyze = useAdminMutation({
    mutationFn: async (f: File) => {
      const base64 = await fileToBase64(f);
      setFile({ name: f.name, base64 });
      return analyzeFn({ data: { tenantId, fileBase64: base64 } });
    },
    silentSuccess: true,
  });

  const commit = useAdminMutation({
    mutationFn: () =>
      commitFn({
        data: {
          tenantId,
          workspaceName: file ? `LexiBite Template — ${file.name}` : "LexiBite Template Import",
          fileBase64: file!.base64,
          originalFilename: file?.name,
        },
      }),
    onSuccessToast: (d: any) =>
      `Import started — ${d.summary.committed} record(s) imported${d.summary.failed ? `, ${d.summary.failed} need attention` : ""}`,
    onSuccess: (d: any) => onImported(d.workspaceId),
  });

  const analysis = analyze.data as
    | {
        isTemplate: boolean;
        sheetCounts: Array<{ sheetName: string; present: boolean; rowCount: number }>;
        issues: TemplateIssue[];
        ready: boolean;
      }
    | undefined;

  return (
    <div className="space-y-4">
      <Button variant="outline" size="sm" onClick={onBack}>
        ← Choose a different way to import
      </Button>

      <SectionCard
        title="Upload your completed LexiBite template"
        description="The file you filled in and saved from the downloaded template."
      >
        <Input
          type="file"
          className="h-11"
          accept=".xlsx,.xls"
          disabled={analyze.isPending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) analyze.mutate(f);
            e.target.value = "";
          }}
        />
      </SectionCard>

      {analysis && !analysis.isTemplate && (
        <SectionCard title="This doesn't look like a LexiBite template">
          <p className="text-sm text-muted-foreground">
            LexiBite couldn't recognise this file as a LexiBite Import Template. If this is your own
            spreadsheet, use Advanced Import instead — LexiBite Intelligence will work out its
            structure for you.
          </p>
          <Button className="mt-3 h-11" variant="outline" onClick={onSwitchToAdvanced}>
            Switch to Advanced Import
          </Button>
        </SectionCard>
      )}

      {analysis?.isTemplate && (
        <SectionCard
          title={
            analysis.ready ? "Your LexiBite file is ready" : "LexiBite found some things to review"
          }
          description={
            analysis.ready
              ? "Everything looks good."
              : `${analysis.issues.filter((i) => i.severity === "needs_attention").length} thing(s) need attention before importing — you can still import now and fix the rest afterwards.`
          }
        >
          <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {analysis.sheetCounts
              .filter((s) => s.present)
              .map((s) => (
                <li key={s.sheetName} className="rounded-md border p-2">
                  <span className="block text-xs text-muted-foreground">{s.sheetName}</span>
                  <span className="font-medium">{s.rowCount} row(s)</span>
                </li>
              ))}
          </ul>

          {analysis.issues.length > 0 && (
            <div className="mt-4 space-y-2">
              {analysis.issues
                .filter((i) => i.severity === "needs_attention")
                .map((i, idx) => (
                  <p key={`na-${idx}`} className="text-sm text-destructive">
                    ⚠ {i.message}
                  </p>
                ))}
              {analysis.issues
                .filter((i) => i.severity === "warning")
                .map((i, idx) => (
                  <p key={`w-${idx}`} className="text-sm text-muted-foreground">
                    ℹ {i.message}
                  </p>
                ))}
            </div>
          )}

          <Button className="mt-4 h-11" disabled={commit.isPending} onClick={() => commit.mutate()}>
            {commit.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing into LexiBite…
              </>
            ) : (
              "Import now"
            )}
          </Button>
        </SectionCard>
      )}
    </div>
  );
}

/* ---------------- Workspace list ---------------- */

function WorkspaceList({
  tenantId,
  onSelect,
}: {
  tenantId: string;
  onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listImportWorkspacesFn);
  const createFn = useServerFn(createImportWorkspaceFn);
  const q = useQuery({
    queryKey: ["restaurant.import.workspaces", tenantId],
    queryFn: () => listFn({ data: { tenantId, limit: 30 } }),
  });
  const [name, setName] = useState("");

  const create = useAdminMutation({
    mutationFn: () => createFn({ data: { tenantId, name } }),
    successMessage: "Import workspace created",
    onSuccess: (data: any) => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["restaurant.import.workspaces", tenantId] });
      onSelect(data.id);
    },
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="New import"
        description="One workspace per migration effort — a restaurant may upload several related files here."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Label htmlFor="imp-name">Workspace name</Label>
            <Input
              id="imp-name"
              className="mt-1 h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Onboarding — Sunset Grill"
            />
          </div>
          <Button
            className="h-11"
            disabled={!name || create.isPending}
            onClick={() => create.mutate()}
          >
            Start import
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Import workspaces">
        {(q.data as any[] | undefined)?.length ? (
          <ul className="divide-y text-sm">
            {(q.data as any[]).map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left hover:bg-muted/50"
                  onClick={() => onSelect(w.id)}
                >
                  <span className="min-w-0">
                    <span className="font-medium">{w.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {w.workspace_number} · {new Date(w.created_at).toLocaleDateString()}
                    </span>
                  </span>
                  <StatusChip tone={statusTone(w.status)}>{w.status.replace(/_/g, " ")}</StatusChip>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No imports yet"
            description="Start one above to bring existing menu, inventory, supplier or recipe data into LexiBite."
          />
        )}
      </SectionCard>
    </div>
  );
}

function statusTone(status: string): StatusTone {
  if (status === "committed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "neutral";
  return "info";
}

/* ---------------- Workspace detail ---------------- */

function WorkspaceDetail({
  tenantId,
  workspaceId,
  onBack,
}: {
  tenantId: string;
  workspaceId: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const getFn = useServerFn(getImportWorkspaceFn);
  const commitFn = useServerFn(commitImportWorkspaceFn);
  const bulkFn = useServerFn(bulkDecideStagedRecordsFn);

  const q = useQuery({
    queryKey: ["restaurant.import.workspace", tenantId, workspaceId],
    queryFn: () => getFn({ data: { tenantId, workspaceId } }),
  });
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["restaurant.import.workspace", tenantId, workspaceId] });

  const commit = useAdminMutation({
    mutationFn: () => commitFn({ data: { tenantId, workspaceId } }),
    onSuccessToast: (d: any) =>
      `Import: ${d.committed} committed${d.failed ? `, ${d.failed} failed` : ""}`,
    onSuccess: invalidate,
  });

  const bulkApprove = useAdminMutation({
    mutationFn: (vars: { domain?: ImportDomain; severity?: string }) =>
      bulkFn({ data: { tenantId, workspaceId, decision: "approved", ...vars } }),
    onSuccessToast: (d: any) => `${d.updated} record(s) approved`,
    onSuccess: invalidate,
  });

  const data = q.data as any;
  const workspace = data?.workspace;
  const sources = (data?.sources as any[]) ?? [];
  const summary = data?.summary;
  const unmappedColumns = (data?.unmappedColumns as any[]) ?? [];

  if (!workspace) return <SectionCard title="Loading…">{null}</SectionCard>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← All imports
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{workspace.workspace_number}</span>
          <StatusChip tone={statusTone(workspace.status)}>
            {workspace.status.replace(/_/g, " ")}
          </StatusChip>
        </div>
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Staged records"
            value={String(summary.total)}
            hint={`${summary.byDomain ? Object.keys(summary.byDomain).length : 0} domain(s)`}
          />
          <StatCard
            label="Needs a decision"
            value={String(summary.byDecision?.pending ?? 0)}
            hint="Exception queue"
          />
          <StatCard
            label="Approved, not yet committed"
            value={String((summary.byDecision?.approved ?? 0) - (summary.committed ?? 0))}
            hint="Ready to import"
          />
          <StatCard
            label="Committed"
            value={String(summary.committed ?? 0)}
            hint={summary.failed ? `${summary.failed} failed` : "0 failed"}
          />
        </div>
      )}

      <AddSource tenantId={tenantId} workspaceId={workspaceId} onUploaded={invalidate} />

      {sources.length > 0 && (
        <SectionCard
          title="Sources"
          description="Raw as uploaded — never overwritten by normalization."
        >
          <ul className="divide-y text-sm">
            {sources.map((s) => (
              <SourceRow key={s.id} tenantId={tenantId} source={s} onChanged={invalidate} />
            ))}
          </ul>
        </SectionCard>
      )}

      <ExceptionQueue
        tenantId={tenantId}
        workspaceId={workspaceId}
        summary={summary}
        onChanged={invalidate}
        onBulkApprove={(domain, severity) => bulkApprove.mutate({ domain, severity })}
      />

      {unmappedColumns.length > 0 && (
        <SectionCard
          title="Columns LexiBite didn't recognise"
          description="Nothing is lost — the original values are kept with every row — but nothing here maps to a LexiBite field yet. Review these before committing."
        >
          <ul className="space-y-1 text-sm">
            {unmappedColumns.map((u: any) => (
              <li key={`${u.sheetName}-${u.domain}`}>
                <span className="text-muted-foreground">
                  {u.sheetName} ({IMPORT_DOMAIN_LABELS[u.domain as ImportDomain] ?? u.domain}):
                </span>{" "}
                {u.columns.join(", ")}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {summary?.byPlan && (
        <SectionCard
          title="Import plan"
          description="What committing right now would actually do — before anything is written."
        >
          <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <li className="rounded-md border p-2">
              <span className="block text-xs text-muted-foreground">CREATE</span>
              <span className="font-medium">{summary.byPlan.create} new record(s)</span>
            </li>
            <li className="rounded-md border p-2">
              <span className="block text-xs text-muted-foreground">UPDATE / LINK</span>
              <span className="font-medium">{summary.byPlan.update} existing record(s)</span>
            </li>
            <li className="rounded-md border p-2">
              <span className="block text-xs text-muted-foreground">REVIEW</span>
              <span className="font-medium">{summary.byPlan.review} row(s) need a decision</span>
            </li>
            <li className="rounded-md border p-2">
              <span className="block text-xs text-muted-foreground">REJECT</span>
              <span className="font-medium">
                {summary.byPlan.reject} row(s) will not be imported
              </span>
            </li>
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Commit"
        description="Only approved records are written, through the same validation manual entry uses. Nothing partial is claimed as success."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button className="h-11" disabled={commit.isPending} onClick={() => commit.mutate()}>
            Import approved data
          </Button>
          {summary?.failed > 0 && (
            <span className="text-sm text-destructive">
              {summary.failed} record(s) failed to commit — see their error below.
            </span>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

/* ---------------- Add source ---------------- */

function AddSource({
  tenantId,
  workspaceId,
  onUploaded,
}: {
  tenantId: string;
  workspaceId: string;
  onUploaded: () => void;
}) {
  const uploadFn = useServerFn(uploadImportSourceFn);
  const [pasted, setPasted] = useState("");
  const [pastedKind, setPastedKind] = useState<"pasted" | "json">("pasted");

  const uploadFile = useAdminMutation({
    mutationFn: async (file: File) => {
      const kind = kindForFile(file);
      if (!kind) throw new Error("Use an XLSX, CSV, PDF or image file.");
      const fileBase64 = await fileToBase64(file);
      return uploadFn({
        data: {
          tenantId,
          workspaceId,
          kind,
          originalFilename: file.name,
          mimeType: file.type || undefined,
          fileBase64,
        },
      });
    },
    successMessage: "File uploaded",
    onSuccess: onUploaded,
  });

  const uploadPasted = useAdminMutation({
    mutationFn: () => uploadFn({ data: { tenantId, workspaceId, kind: pastedKind, text: pasted } }),
    successMessage: "Pasted data added",
    onSuccess: () => {
      setPasted("");
      onUploaded();
    },
  });

  return (
    <SectionCard
      title="Add a source"
      description="Upload an XLSX/CSV export, a PDF/image (staged for a document-AI provider once one is configured), or paste data straight from a spreadsheet."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="imp-file">Upload a file</Label>
          <Input
            id="imp-file"
            type="file"
            className="mt-1 h-11"
            accept=".xlsx,.xls,.csv,.pdf,image/*"
            disabled={uploadFile.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFile.mutate(file);
              e.target.value = "";
            }}
          />
        </div>
        <div>
          <Label htmlFor="imp-paste">Paste tabular data or JSON</Label>
          <Textarea
            id="imp-paste"
            className="mt-1"
            rows={3}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"Name\tSKU\tQty\nRice\tITM-1\t250"}
          />
          <div className="mt-2 flex items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={pastedKind}
              onChange={(e) => setPastedKind(e.target.value as any)}
            >
              <option value="pasted">Tabular (tab/comma)</option>
              <option value="json">JSON</option>
            </select>
            <Button
              size="sm"
              className="h-9"
              disabled={!pasted || uploadPasted.isPending}
              onClick={() => uploadPasted.mutate()}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

/* ---------------- One source: parse + stage each sheet ---------------- */

function SourceRow({
  tenantId,
  source,
  onChanged,
}: {
  tenantId: string;
  source: any;
  onChanged: () => void;
}) {
  const parseFn = useServerFn(parseImportSourceFn);
  const parse = useAdminMutation({
    mutationFn: () => parseFn({ data: { tenantId, sourceId: source.id } }),
    onSuccessToast: (d: any) => `Found ${d.sheets.length} sheet(s), ${d.source.row_count} row(s)`,
    onSuccess: onChanged,
  });

  const sheets: any[] = source.detected_domains ?? [];

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{source.original_filename ?? `${source.kind} paste`}</span>
          <span className="block text-xs text-muted-foreground">
            {source.kind.toUpperCase()} · {source.row_count ?? 0} row(s)
          </span>
        </span>
        <div className="flex items-center gap-2">
          <StatusChip
            tone={
              source.status === "parsed"
                ? "success"
                : source.status.includes("unavailable") || source.status === "failed"
                  ? "danger"
                  : "neutral"
            }
          >
            {source.status.replace(/_/g, " ")}
          </StatusChip>
          {source.status === "uploaded" && (
            <Button
              size="sm"
              className="h-9"
              disabled={parse.isPending}
              onClick={() => parse.mutate()}
            >
              Analyse
            </Button>
          )}
        </div>
      </div>
      {source.parse_error && <p className="mt-1 text-xs text-destructive">{source.parse_error}</p>}
      {source.status === "parsed" && sheets.length > 0 && (
        <div className="mt-2 space-y-2">
          {sheets.map((s: any) => (
            <SheetStager
              key={s.sheetName}
              tenantId={tenantId}
              sourceId={source.id}
              sheetName={s.sheetName}
              guesses={s.guesses}
              onStaged={onChanged}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function SheetStager({
  tenantId,
  sourceId,
  sheetName,
  guesses,
  onStaged,
}: {
  tenantId: string;
  sourceId: string;
  sheetName: string;
  guesses: Array<{ domain: ImportDomain; confidence: number }>;
  onStaged: () => void;
}) {
  const suggestFn = useServerFn(suggestImportMappingFn);
  const confirmFn = useServerFn(confirmImportMappingFn);
  // Empty string means "no domain chosen" — LexiBite Intelligence found no
  // confident match, so staging this sheet requires a deliberate human pick
  // rather than a silent guess (an unreviewed default here previously
  // caused a sheet with no real match, e.g. a README or notes tab, to be
  // staged under whatever domain happened to be first in the list,
  // misreporting every one of its rows as that domain's required field
  // being "missing").
  const [domain, setDomain] = useState<ImportDomain | "">(guesses[0]?.domain ?? "");
  const [mapping, setMapping] = useState<Array<{
    sourceColumn: string;
    canonicalField: string | null;
    confidence: number;
    auto: boolean;
  }> | null>(null);
  const [open, setOpen] = useState(false);
  const [overrideNonOperational, setOverrideNonOperational] = useState(false);
  const sheetIdentity = classifySheetIdentity(sheetName);
  const flaggedNonOperational = guesses.length === 0 && looksNonOperational(sheetName);
  const unsupportedSheet = sheetIdentity.kind === "unsupported";

  const suggest = useAdminMutation({
    mutationFn: () =>
      suggestFn({ data: { tenantId, sourceId, sheetName, domain: domain as ImportDomain } }),
    silentSuccess: true,
    onSuccess: (d: any) => setMapping(d.mapping),
  });

  const stage = useAdminMutation({
    mutationFn: () =>
      confirmFn({
        data: {
          tenantId,
          sourceId,
          sheetName,
          domain: domain as ImportDomain,
          mapping: mapping ?? [],
        },
      }),
    onSuccessToast: (d: any) => `Staged ${d.staged} of ${d.total} row(s)`,
    onSuccess: () => {
      setOpen(false);
      onStaged();
    },
  });

  if (unsupportedSheet) {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{sheetName}</span>
          <StatusChip tone="neutral">Not importable</StatusChip>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{sheetIdentity.reason}</p>
      </div>
    );
  }

  if (flaggedNonOperational && !overrideNonOperational) {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{sheetName}</span>
          <StatusChip tone="neutral">Not imported</StatusChip>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          LexiBite identified this sheet as documentation or test material, not operational data.
        </p>
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline underline-offset-2"
          onClick={() => setOverrideNonOperational(true)}
        >
          Import this sheet anyway
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{sheetName}</span>
        <span className="flex flex-wrap items-center gap-1">
          {guesses.length === 0 ? (
            <StatusChip tone="warning">No confident domain match — choose one</StatusChip>
          ) : (
            guesses.map((g) => (
              <StatusChip key={g.domain} tone="info">
                {IMPORT_DOMAIN_LABELS[g.domain]} · {domainGuessLabel(g.confidence)}
              </StatusChip>
            ))
          )}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value as ImportDomain | "");
            setMapping(null);
          }}
        >
          <option value="">— select a domain —</option>
          {IMPORT_DOMAINS.map((d) => (
            <option key={d} value={d}>
              {IMPORT_DOMAIN_LABELS[d]}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          disabled={suggest.isPending || domain === ""}
          onClick={() => {
            setOpen(true);
            suggest.mutate();
          }}
        >
          Review column mapping
        </Button>
      </div>
      {open && mapping && (
        <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
          {mapping.map((m, i) => (
            <div key={m.sourceColumn} className="flex flex-wrap items-center gap-2">
              <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
                {m.sourceColumn}
              </span>
              <span>→</span>
              <select
                className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                value={m.canonicalField ?? ""}
                onChange={(e) =>
                  setMapping((prev) =>
                    prev!.map((row, idx) =>
                      idx === i
                        ? { ...row, canonicalField: e.target.value || null, auto: false }
                        : row,
                    ),
                  )
                }
              >
                <option value="">— ignore this column —</option>
                {CANONICAL_FIELDS[domain as ImportDomain].map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                    {f.required ? " (required)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <Button
            size="sm"
            className="h-9"
            disabled={stage.isPending}
            onClick={() => stage.mutate()}
          >
            Stage this sheet
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Exception queue ---------------- */

function ExceptionQueue({
  tenantId,
  workspaceId,
  summary,
  onChanged,
  onBulkApprove,
}: {
  tenantId: string;
  workspaceId: string;
  summary: any;
  onChanged: () => void;
  onBulkApprove: (domain?: ImportDomain, severity?: string) => void;
}) {
  const [domain, setDomain] = useState<ImportDomain | "">("");
  const [severity, setSeverity] = useState("");

  if (!summary || summary.total === 0) return null;

  return (
    <SectionCard
      title="Review"
      description="LexiBite Intelligence does the bulk work — exact matches are already approved. A human resolves the rest."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {Object.entries(SEVERITY_META).map(([key, meta]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSeverity(severity === key ? "" : key)}
            className={`rounded-full border px-2.5 py-1 text-xs ${severity === key ? "border-primary" : ""}`}
          >
            {meta.icon} {meta.label} · {summary.bySeverity?.[key] ?? 0}
          </button>
        ))}
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={domain}
          onChange={(e) => setDomain(e.target.value as any)}
        >
          <option value="">All domains</option>
          {IMPORT_DOMAINS.map((d) => (
            <option key={d} value={d}>
              {IMPORT_DOMAIN_LABELS[d]}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          onClick={() => onBulkApprove(domain || undefined, severity || undefined)}
        >
          Approve all shown
        </Button>
      </div>
      <StagedRecordsList
        tenantId={tenantId}
        workspaceId={workspaceId}
        domain={domain || undefined}
        severity={severity || undefined}
        onChanged={onChanged}
      />
    </SectionCard>
  );
}

function StagedRecordsList({
  tenantId,
  workspaceId,
  domain,
  severity,
  onChanged,
}: {
  tenantId: string;
  workspaceId: string;
  domain?: ImportDomain;
  severity?: string;
  onChanged: () => void;
}) {
  const listFn = useServerFn(listStagedRecordsFn);
  const decideFn = useServerFn(decideStagedRecordFn);
  const q = useQuery({
    queryKey: ["restaurant.import.staged", tenantId, workspaceId, domain, severity],
    queryFn: () =>
      listFn({ data: { tenantId, workspaceId, domain, severity: severity as any, limit: 300 } }),
  });

  const decide = useAdminMutation({
    mutationFn: (vars: {
      recordId: string;
      decision: "approved" | "rejected" | "skipped" | "pending";
      matchedEntityId?: string;
      mappedDataPatch?: Record<string, string | number | boolean | null>;
    }) => decideFn({ data: { tenantId, ...vars } }),
    onSuccessToast: (_data, vars) =>
      vars.decision === "approved"
        ? "Record approved for import"
        : vars.decision === "pending"
          ? "Record re-evaluated — returned to review"
          : "Record rejected",
    onSuccess: onChanged,
  });

  // Review is the human-control surface. Show every uncommitted row here,
  // including Ready/auto-approved rows, so a configuration user can still
  // edit anything before the final commit.
  const rows = ((q.data as any[]) ?? []).filter((r) => !r.committed_at);

  if (rows.length === 0)
    return (
      <EmptyState
        title="Nothing to review here"
        description="Every record in this view is already decided."
      />
    );

  return (
    <ul className="max-h-[32rem] divide-y overflow-y-auto text-sm">
      {rows.map((r) => (
        <StagedRowItem key={r.id} r={r} tenantId={tenantId} decide={decide} />
      ))}
    </ul>
  );
}

function StagedRowItem({
  r,
  tenantId,
  decide,
}: {
  r: any;
  tenantId: string;
  decide: {
    isPending: boolean;
    mutate: (vars: {
      recordId: string;
      decision: "approved" | "rejected" | "skipped" | "pending";
      matchedEntityId?: string;
      mappedDataPatch?: Record<string, string | number | boolean | null>;
    }) => void;
  };
}) {
  const candidates: Array<{ id: string; label: string; score: number }> = r.match_candidates ?? [];
  const [chosenId, setChosenId] = useState<string>(r.matched_entity_id ?? candidates[0]?.id ?? "");
  const [showEvidence, setShowEvidence] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const meta = SEVERITY_META[r.severity] ?? SEVERITY_META.new_entity!;
  const label =
    r.mapped_data.name ??
    r.mapped_data.menuItemName ??
    r.mapped_data.itemName ??
    r.mapped_data.productMenuItemName ??
    r.mapped_data.code ??
    "Row";
  const linkedTo =
    r.mapped_data.productMenuItemName ??
    (r.domain === "product_station" ? r.mapped_data.menuItemName : null) ??
    r.mapped_data.groupCode ??
    r.mapped_data.modifierGroupCode ??
    r.mapped_data.stationCode ??
    null;

  const canAct = !r.committed_at;
  const pending = r.decision === "pending";
  const hasBlockingError = Array.isArray(r.validation_errors) && r.validation_errors.length > 0;

  return (
    <>
      <li className="flex flex-wrap items-start justify-between gap-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="font-medium">
            {meta.icon} {label}
          </span>
          <span className="block text-xs text-muted-foreground">
            {r.sheet_name ? `${r.sheet_name} · ` : ""}
            {IMPORT_DOMAIN_LABELS[r.domain as ImportDomain]} · row {r.source_row} · {meta.label}
            {linkedTo && linkedTo !== label ? ` · linked to "${linkedTo}"` : ""}
          </span>
          {r.validation_errors?.length > 0 && (
            <span className="block text-xs text-muted-foreground">
              {r.validation_errors.join(" ")}
            </span>
          )}
          {r.commit_error && (
            <span className="block text-xs text-destructive">Commit failed: {r.commit_error}</span>
          )}
          {r.match_evidence?.length > 0 && (
            <button
              type="button"
              className="mt-0.5 block text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setShowEvidence((v) => !v)}
            >
              {showEvidence ? "Hide" : "Why this match?"}
            </button>
          )}
          {showEvidence && r.match_evidence?.length > 0 && (
            <span className="block text-xs text-muted-foreground">{r.match_evidence.join(" ")}</span>
          )}
          {candidates.length > 1 && (
            <span className="mt-1 flex items-center gap-1">
              <span className="text-xs text-muted-foreground">Match:</span>
              <select
                className="h-7 rounded-md border bg-background px-1 text-xs"
                value={chosenId}
                onChange={(e) => setChosenId(e.target.value)}
              >
                {candidates.map((c, idx) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({idx === 0 ? "best match" : "possible match"})
                  </option>
                ))}
              </select>
            </span>
          )}
        </span>

        {canAct && (
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={decide.isPending}
              onClick={() => setCatalogOpen(true)}
            >
              {r.severity === "cannot_map" ? "Add to catalog" : "Edit catalog"}
            </Button>

            {pending && (
              <>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      recordId: r.id,
                      decision: "approved",
                      matchedEntityId: candidates.length > 1 ? chosenId : undefined,
                    })
                  }
                >
                  {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ recordId: r.id, decision: "rejected" })}
                >
                  Reject
                </Button>
              </>
            )}
          </span>
        )}
      </li>

      <CatalogEditDialog
        record={r}
        open={catalogOpen}
        busy={decide.isPending}
        onOpenChange={setCatalogOpen}
        tenantId={tenantId}
        onSave={(mappedDataPatch) => {
          decide.mutate({
            recordId: r.id,
            decision: "pending",
            matchedEntityId: candidates.length > 1 ? chosenId : undefined,
            mappedDataPatch,
          });
          setCatalogOpen(false);
        }}
      />
    </>
  );
}

function CatalogEditDialog({
  record,
  open,
  busy,
  tenantId,
  onOpenChange,
  onSave,
}: {
  record: any;
  open: boolean;
  busy: boolean;
  tenantId: string;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: Record<string, string | number | boolean | null>) => void;
}) {
  const initial = Object.entries(record.mapped_data ?? {}).filter(
    ([key, value]) => !key.toLowerCase().endsWith("id") && key !== "matchedEntityId",
  ) as Array<[string, string | number | boolean | null]>;
  const [values, setValues] = useState<Record<string, string | number | boolean | null>>({});
  const categoriesFn = useServerFn(listRestaurantInventoryCategoriesFn);
  const categoriesQuery = useQuery({
    queryKey: ["restaurant.inventory.categories", tenantId],
    queryFn: () => categoriesFn({ data: { tenantId } }),
    enabled: open,
    staleTime: 60_000,
  });
  const inventoryCategories = ((categoriesQuery.data as any[]) ?? []).filter((category) => category.active !== false);
  const categoryById = new Map(inventoryCategories.map((category) => [category.id, category]));

  const menusFn = useServerFn(listRestaurantMenusFn);
  const menuItemsFn = useServerFn(listRestaurantMenuItemsFn);
  const [selectedMenuId, setSelectedMenuId] = useState("");
  const menusQuery = useQuery({
    queryKey: ["restaurant.import.menus", tenantId],
    queryFn: () => menusFn({ data: { tenantId, limit: 200 } }),
    enabled: open && initial.some(([key]) => key === "productMenuItemName"),
    staleTime: 60_000,
  });
  const menuItemsQuery = useQuery({
    queryKey: ["restaurant.import.menu-items", tenantId, selectedMenuId],
    queryFn: () => menuItemsFn({ data: { tenantId, menuId: selectedMenuId, limit: 500 } }),
    enabled: open && !!selectedMenuId,
    staleTime: 60_000,
  });
  const selectedMenu = ((menusQuery.data as any[]) ?? []).find((menu) => menu.id === selectedMenuId);

  // Re-seed every time a different record is opened.
  useEffect(() => {
    const next: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of initial) next[key] = value;
    setValues(next);
    setSelectedMenuId("");
  }, [record.id, open]);

  const setValue = (key: string, raw: string) => {
    const current = values[key];
    if (typeof current === "number") {
      const n = Number(raw);
      setValues((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : raw }));
    } else if (typeof current === "boolean") {
      setValues((prev) => ({ ...prev, [key]: raw === "true" }));
    } else {
      setValues((prev) => ({ ...prev, [key]: raw }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{record.severity === "cannot_map" ? "Add to catalog" : "Edit catalog entry"}</DialogTitle>
          <DialogDescription>
            Review and edit every mapped field before LexiBite accepts this row. Nothing is written to
            the live catalog until you use the final import action.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {initial.map(([key, value]) => {
            const fieldValue = values[key] ?? "";
            const isLong = key.toLowerCase().includes("description") || key.toLowerCase().includes("notes");
            return (
              <div key={key} className={isLong ? "sm:col-span-2" : ""}>
                <Label className="text-xs">{key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}</Label>
                {key === "productMenuItemName" ? (
                  <div className="space-y-2">
                    <select
                      className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                      value={selectedMenuId}
                      disabled={menusQuery.isLoading || busy}
                      onChange={(e) => {
                        setSelectedMenuId(e.target.value);
                        setValues((prev) => ({ ...prev, productMenuItemName: "" }));
                      }}
                    >
                      <option value="">— Select menu first —</option>
                      {((menusQuery.data as any[]) ?? []).map((menu) => (
                        <option key={menu.id} value={menu.id}>
                          {menu.name}{menu.status ? ` · ${menu.status}` : ""}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                      value={String(fieldValue ?? "")}
                      disabled={!selectedMenuId || menuItemsQuery.isLoading || busy}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, productMenuItemName: e.target.value }))
                      }
                    >
                      <option value="">
                        {!selectedMenuId ? "— Select a menu above —" : "— Select menu item —"}
                      </option>
                      {((menuItemsQuery.data as any[]) ?? []).map((item) => (
                        <option key={item.id} value={item.name}>
                          {item.name}{item.available === false ? " · unavailable" : ""}
                        </option>
                      ))}
                    </select>
                    {selectedMenu && (
                      <p className="text-xs text-muted-foreground">
                        Selecting from <span className="font-medium">{selectedMenu.name}</span> uses
                        the existing menu item instead of creating another name match.
                      </p>
                    )}
                  </div>
                ) : key === "categoryName" ? (
                  <select
                    className="mt-1 h-10 w-full rounded-md border bg-background px-2 text-sm"
                    value={String(fieldValue ?? "")}
                    disabled={categoriesQuery.isLoading || busy}
                    onChange={(e) => {
                      const selected = categoryById.get(e.target.value);
                      setValues((prev) => ({
                        ...prev,
                        categoryName: selected?.name ?? "",
                        categoryId: selected?.id ?? null,
                      }));
                    }}
                  >
                    <option value="">— Select existing category —</option>
                    {inventoryCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.parent_id ? "↳ " : ""}{category.name}
                      </option>
                    ))}
                  </select>
                ) : isLong ? (
                  <Textarea
                    className="mt-1"
                    rows={3}
                    value={String(fieldValue ?? "")}
                    onChange={(e) => setValue(key, e.target.value)}
                  />
                ) : typeof value === "boolean" ? (
                  <select
                    className="mt-1 h-10 w-full rounded-md border bg-background px-2 text-sm"
                    value={String(fieldValue)}
                    onChange={(e) => setValue(key, e.target.value)}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <Input
                    className="mt-1 h-10"
                    value={String(fieldValue ?? "")}
                    onChange={(e) => setValue(key, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSave(values)} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
