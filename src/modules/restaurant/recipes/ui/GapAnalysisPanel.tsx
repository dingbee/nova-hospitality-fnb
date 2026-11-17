/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Recipe → catalog gap analysis.
 *
 * A report, not an action. It states plainly how much of the recipe book can
 * actually be costed today and, where it cannot, exactly which gap is in the
 * way. Nothing here changes data.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatCard } from "@/components/os/StatCard";
import { StatusChip } from "@/components/os/StatusChip";
import { GAP_CLASSES, GAP_CLASS_LABELS, type GapClass } from "../gap-analysis";
import { getRecipeGapAnalysisFn } from "../enrichment.functions";

const CLASS_TONE: Record<GapClass, "success" | "warning" | "danger" | "neutral"> = {
  VERIFIED_MATCH: "success",
  MATCH_REQUIRES_REVIEW: "warning",
  MISSING_CATALOG_ITEM: "danger",
  UNIT_MISMATCH: "danger",
  MISSING_STOCK_UNIT: "warning",
  AMBIGUOUS: "neutral",
};

const COSTING_TONE: Record<string, "success" | "warning" | "neutral"> = {
  COSTABLE: "success",
  PARTIAL: "warning",
  NON_COSTABLE: "neutral",
};

export function GapAnalysisPanel({ tenantId }: { tenantId: string | undefined }) {
  const fn = useServerFn(getRecipeGapAnalysisFn);
  const report = useQuery({
    queryKey: ["restaurant.gapAnalysis", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
  });

  const data: any = report.data;
  const [onlyGaps, setOnlyGaps] = React.useState(true);

  if (!data) {
    return (
      <SectionCard title="Recipe / catalog gap analysis" description="Classifying every imported ingredient line against the master catalog.">
        <EmptyState title={report.isLoading ? "Analysing…" : "No analysis yet"} description="Import the recipe master first." />
      </SectionCard>
    );
  }

  const recipes: any[] = data.recipes ?? [];
  const shown = onlyGaps ? recipes.filter((r) => r.costingState !== "COSTABLE") : recipes;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Recipes" value={String(data.recipeCount)} />
        <StatCard label="Ingredient lines" value={String(data.lineCount)} />
        <StatCard label="Costable recipes" value={String(data.costing.costable)} tone="green" />
        <StatCard
          label="Non-costable / partial"
          value={`${data.costing.nonCostable} / ${data.costing.partial}`}
          tone="warn"
        />
      </div>

      <SectionCard
        title="Ingredient line classification"
        description="Every imported line falls into exactly one class. A line is only verified when it maps to a SKU whose stock unit can express the recipe quantity."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GAP_CLASSES.map((c) => (
            <div key={c} className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <StatusChip tone={CLASS_TONE[c]}>{GAP_CLASS_LABELS[c]}</StatusChip>
                <span className="text-2xl font-semibold tabular-nums">{data.counts[c] ?? 0}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Master catalog: {data.catalogSize} items, of which {data.catalogWithoutStockUnit} have no
          stock unit recorded. No recipe is activated and no cost is published from partial data.
        </p>
      </SectionCard>

      <SectionCard
        title="Highest-frequency missing catalog ingredients"
        description="Ingredients the recipe books rely on that the master catalog does not contain, most used first. They are proposals for review — nothing is created automatically."
      >
        {(data.topMissingIngredients ?? []).length === 0 ? (
          <EmptyState title="Nothing missing" description="Every ingredient has at least a plausible catalog candidate." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3">Ingredient</th>
                  <th className="py-2 pr-3">Lines</th>
                  <th className="py-2 pr-3">Recipes</th>
                </tr>
              </thead>
              <tbody>
                {data.topMissingIngredients.map((m: any) => (
                  <tr key={m.ingredientKey} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{m.ingredientName}</td>
                    <td className="py-2 pr-3 tabular-nums">{m.occurrences}</td>
                    <td className="py-2 pr-3 tabular-nums">{m.recipes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Affected recipes"
        description="Costing state per recipe. COSTABLE means every line is mapped, unit-verified and carries a cost basis."
      >
        <label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
          Show only recipes with gaps
        </label>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Recipe</th>
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3">Lines</th>
                {GAP_CLASSES.map((c) => (
                  <th key={c} className="py-2 pr-3 text-xs uppercase tracking-wide">
                    {GAP_CLASS_LABELS[c]}
                  </th>
                ))}
                <th className="py-2 pr-3">Costing</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{r.code ?? "—"}</td>
                  <td className="py-2 pr-3">{r.name}</td>
                  <td className="py-2 pr-3">{r.servicePeriod ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.lineCount}</td>
                  {GAP_CLASSES.map((c) => (
                    <td key={c} className="py-2 pr-3 tabular-nums">
                      {r.counts[c] || "—"}
                    </td>
                  ))}
                  <td className="py-2 pr-3">
                    <StatusChip tone={COSTING_TONE[r.costingState] ?? "neutral"}>
                      {r.costingState}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}