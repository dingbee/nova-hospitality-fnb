/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Recipe Master — the CATALOG → RECIPE INGREDIENT → RECIPE spine.
 *
 * Recipes imported from the historical recipe books arrive as DRAFTS. A recipe
 * only becomes eligible for activation once every ingredient line is mapped to
 * a catalog SKU, because an unmapped ingredient means an unknown cost, not a
 * zero one. Nothing on this screen creates stock, prices or menu items.
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
import { IngredientMappingPanel } from "./IngredientMappingPanel";
import { GapAnalysisPanel } from "./GapAnalysisPanel";
import {
  EnrichmentAuditPanel,
  MissingCatalogItemsPanel,
  StockUnitCompletenessPanel,
} from "./CatalogEnrichmentPanel";
import {
  importRecipeMasterFn,
  listImportedRecipesFn,
  listRecipeImportBatchesFn,
  listRecipeReviewQueueFn,
  resolveRecipeReviewRowFn,
} from "../recipe-import.functions";

const TABS = [
  { id: "recipes", label: "Recipes" },
  { id: "mapping", label: "Ingredient mapping" },
  { id: "gaps", label: "Gap analysis" },
  { id: "enrichment", label: "Catalog enrichment" },
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

function quantityLabel(line: any) {
  const min = line.quantity_min;
  const max = line.quantity_max;
  const unit = line.source_unit ?? "";
  if (min === null && max === null) return `— ${unit}`.trim();
  if (min !== null && max !== null && Number(min) !== Number(max))
    return `${min}–${max} ${unit}`.trim();
  return `${min ?? max} ${unit}`.trim();
}

export function RecipeImportWorkbench() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const qc = useQueryClient();

  const [tab, setTab] = React.useState<TabId>("recipes");
  const [search, setSearch] = React.useState("");
  const [servicePeriod, setServicePeriod] = React.useState("");
  const [completeness, setCompleteness] = React.useState("");
  const [detail, setDetail] = React.useState<any | null>(null);

  const listFn = useServerFn(listImportedRecipesFn);
  const batchesFn = useServerFn(listRecipeImportBatchesFn);
  const queueFn = useServerFn(listRecipeReviewQueueFn);
  const importFn = useServerFn(importRecipeMasterFn);
  const resolveFn = useServerFn(resolveRecipeReviewRowFn);

  const recipesQuery = useQuery({
    queryKey: ["restaurant.recipeMaster", tenantId, { search, servicePeriod, completeness }],
    enabled: Boolean(tenantId),
    queryFn: () =>
      listFn({
        data: {
          tenantId: tenantId!,
          search: search || undefined,
          servicePeriod: servicePeriod || undefined,
          completeness: (completeness || undefined) as any,
          limit: 1000,
        },
      }),
  });

  const batches = useQuery({
    queryKey: ["restaurant.recipeMaster.batches", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => batchesFn({ data: { tenantId: tenantId! } }),
  });

  const queue = useQuery({
    queryKey: ["restaurant.recipeMaster.queue", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => queueFn({ data: { tenantId: tenantId! } }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.recipeMaster"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.recipeMaster.batches", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.recipeMaster.queue", tenantId] });
  };

  const runImport = useAdminMutation({
    mutationFn: () => importFn({ data: { tenantId: tenantId! } }),
    successMessage: "Recipe master import completed.",
    onSuccess: invalidate,
  });
  const resolveRow = useAdminMutation({
    mutationFn: (rowId: string) => resolveFn({ data: { tenantId: tenantId!, rowId } }),
    successMessage: "Marked as reviewed.",
    onSuccess: invalidate,
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  const recipes: any[] = recipesQuery.data?.recipes ?? [];
  const readiness: any = recipesQuery.data?.readiness ?? {};
  const reviewRows: any[] = queue.data ?? [];
  const unresolvedLines = recipes.flatMap((r) =>
    (r.lines ?? [])
      .filter((l: any) => l.mapping_status !== "resolved")
      .map((l: any) => ({ ...l, recipe: r })),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="F&B Recipe Master"
        description="Historical recipe books mapped onto the master catalog. Recipes stay in draft until every ingredient resolves to a SKU — no stock, prices or menu items are created here."
        actions={
          <Button
            onClick={() => runImport.mutate(undefined as never)}
            disabled={runImport.isPending || !tenantId}
          >
            {runImport.isPending ? "Importing…" : "Run recipe master import"}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Recipes" value={String(recipes.length)} />
        <StatCard
          label="Eligible for activation"
          value={String(readiness.recipesEligibleForActivation ?? 0)}
        />
        <StatCard label="Draft / review" value={String(readiness.recipesInDraftOrReview ?? 0)} />
        <StatCard label="Unmapped ingredients" value={String(unresolvedLines.length)} />
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

      {tab === "recipes" && (
        <SectionCard
          title="Recipes"
          description="Search by recipe code or name, and filter by service period and costing completeness."
        >
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              className="h-10 w-56"
              placeholder="Search code or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              value={servicePeriod}
              onChange={setServicePeriod}
              placeholder="All service periods"
              options={[
                { value: "LUNCH", label: "Lunch" },
                { value: "DINNER", label: "Dinner" },
              ]}
            />
            <Select
              value={completeness}
              onChange={setCompleteness}
              placeholder="All costing states"
              options={[
                { value: "complete", label: "Complete costing" },
                { value: "incomplete", label: "Partial / incomplete costing" },
              ]}
            />
          </div>

          {recipes.length === 0 ? (
            <EmptyState
              title="No recipes"
              description="Run the recipe master import, or adjust your filters."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3">Code</th>
                    <th className="py-2 pr-3">Recipe</th>
                    <th className="py-2 pr-3">Service</th>
                    <th className="py-2 pr-3">Section</th>
                    <th className="py-2 pr-3">Ingredients</th>
                    <th className="py-2 pr-3">Unmapped</th>
                    <th className="py-2 pr-3">Costing</th>
                    <th className="py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recipes.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/50"
                      onClick={() => setDetail(r)}
                    >
                      <td className="py-2 pr-3 font-mono text-xs">{r.code}</td>
                      <td className="py-2 pr-3">{r.name}</td>
                      <td className="py-2 pr-3">{r.service_period ?? "—"}</td>
                      <td className="py-2 pr-3">{r.source_section ?? "—"}</td>
                      <td className="py-2 pr-3">{r.lineCount}</td>
                      <td className="py-2 pr-3">{r.unresolvedCount}</td>
                      <td className="py-2 pr-3">
                        <StatusChip tone={r.costingComplete ? "success" : "warning"}>
                          {r.costingComplete ? "Complete" : "Partial"}
                        </StatusChip>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusChip tone={r.status === "active" ? "success" : "neutral"}>
                          {r.status}
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

      {tab === "mapping" && <IngredientMappingPanel tenantId={tenantId} />}

      {tab === "gaps" && <GapAnalysisPanel tenantId={tenantId} />}

      {tab === "enrichment" && (
        <div className="space-y-4">
          <MissingCatalogItemsPanel tenantId={tenantId} />
          <StockUnitCompletenessPanel tenantId={tenantId} />
          <EnrichmentAuditPanel tenantId={tenantId} />
        </div>
      )}

      {tab === "quality" && (
        <SectionCard
          title="Data quality queue"
          description="Rows the import refused to resolve by guessing, plus any conflict with an existing recipe or line. Source provenance is never altered."
        >
          {reviewRows.length === 0 ? (
            <EmptyState
              title="Nothing to review"
              description="Every imported row resolved cleanly."
            />
          ) : (
            <ul className="divide-y">
              {reviewRows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      {r.recipe_code} · row {r.source_row} · {r.entity_type} · {r.result}
                      {r.mapping_result ? ` · ${r.mapping_result}` : ""}
                    </p>
                    <p className="font-medium">
                      {r.ingredient_name
                        ? `${r.recipe_name} — ${r.ingredient_name}`
                        : r.recipe_name}
                    </p>
                    {r.message ? (
                      <p className="text-sm text-muted-foreground">{r.message}</p>
                    ) : null}
                    {(r.conflicts ?? []).map((c: any) => (
                      <p key={c.field} className="text-sm text-muted-foreground">
                        • {c.field}: existing “{String(c.existing ?? "—")}” vs incoming “
                        {String(c.incoming ?? "—")}”
                      </p>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resolveRow.mutate(r.id)}
                    disabled={resolveRow.isPending}
                  >
                    Mark reviewed
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "imports" && (
        <SectionCard
          title="Import history"
          description="Every recipe import is auditable: source file, who ran it, when, and the outcome of each recipe and ingredient line."
        >
          {(batches.data ?? []).length === 0 ? (
            <EmptyState
              title="No imports yet"
              description="Run the recipe master import to create the first batch."
            />
          ) : (
            <ul className="divide-y">
              {(batches.data ?? []).map((b: any) => (
                <li key={b.id} className="py-3">
                  <p className="font-medium">{b.source_file}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(b.imported_at).toLocaleString()} · {b.total_recipes} recipes /{" "}
                    {b.total_lines} lines · recipes created {b.recipes_created} · unchanged{" "}
                    {b.recipes_unchanged} · conflicts {b.recipes_conflicted} · lines created{" "}
                    {b.lines_created} · unchanged {b.lines_unchanged} · conflicts{" "}
                    {b.lines_conflicted} · matched {b.lines_matched} · unresolved{" "}
                    {b.lines_unresolved} · review {b.lines_review_required} · errors {b.error_count}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <Sheet open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
          </SheetHeader>
          {detail ? (
            <div className="mt-4 space-y-4 text-sm">
              <dl className="space-y-2">
                {[
                  ["Recipe code", detail.code],
                  ["Version", detail.version],
                  ["Service period", detail.service_period ?? "—"],
                  ["Section", detail.source_section ?? "—"],
                  ["Portion basis", detail.portion_basis ?? "—"],
                  ["Status", detail.status],
                  ["Costing", detail.costingComplete ? "Complete" : "Partial / incomplete"],
                  ["Source file", detail.source_file ?? "—"],
                  ["Source sheet", detail.source_sheet ?? "—"],
                  ["Import status", detail.import_status ?? "—"],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-medium">{String(value)}</dd>
                  </div>
                ))}
              </dl>

              {detail.instructions ? (
                <div>
                  <p className="mb-1 text-muted-foreground">Preparation method</p>
                  <p>{detail.instructions}</p>
                </div>
              ) : null}

              <div>
                <p className="mb-2 text-muted-foreground">
                  Ingredients ({(detail.lines ?? []).length})
                </p>
                <ul className="divide-y">
                  {(detail.lines ?? []).map((l: any) => (
                    <li key={l.id} className="flex items-start justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="font-medium">{l.ingredient_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {quantityLabel(l)}
                          {l.candidate_sku ? ` · candidate ${l.candidate_sku}` : ""}
                        </p>
                      </div>
                      <StatusChip tone={l.mapping_status === "resolved" ? "success" : "warning"}>
                        {l.mapping_status === "resolved"
                          ? "Mapped"
                          : l.mapping_status === "review_required"
                            ? "Review"
                            : "Unmapped"}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
