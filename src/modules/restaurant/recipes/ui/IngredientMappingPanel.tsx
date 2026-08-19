/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Ingredient mapping workbench.
 *
 * Legacy recipe ingredients on the left, master catalog candidates on the
 * right, and a person in the middle. The screen suggests and explains; it
 * never decides. No stock item is ever created here, and the original source
 * values stay exactly as the workbook wrote them.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  decideIngredientMappingFn,
  listIngredientMappingQueueFn,
  listMappingDecisionsFn,
} from "../recipe-import.functions";

type StateFilter = "unmapped" | "suggested" | "confirmed" | "review_required" | "all";

const STATE_TABS: { id: StateFilter; label: string; countKey: string }[] = [
  { id: "unmapped", label: "Unmapped", countKey: "unmapped" },
  { id: "suggested", label: "Suggested", countKey: "suggested" },
  { id: "confirmed", label: "Confirmed", countKey: "confirmed" },
  { id: "review_required", label: "Review required", countKey: "reviewRequired" },
  { id: "all", label: "All", countKey: "total" },
];

const CONFIDENCE_TONE: Record<string, "success" | "warning" | "neutral"> = {
  exact: "success",
  high: "success",
  medium: "warning",
  low: "neutral",
};

function quantityLabel(row: any) {
  const { quantityMin: min, quantityMax: max, sourceUnit } = row;
  const unit = sourceUnit ?? "";
  if (min === null && max === null) return unit || "—";
  if (min !== null && max !== null && Number(min) !== Number(max))
    return `${min}–${max} ${unit}`.trim();
  return `${min ?? max} ${unit}`.trim();
}

export function IngredientMappingPanel({ tenantId }: { tenantId: string | undefined }) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<StateFilter>("unmapped");
  const [recipeId, setRecipeId] = React.useState("");
  const [servicePeriod, setServicePeriod] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [openRow, setOpenRow] = React.useState<any | null>(null);
  const [note, setNote] = React.useState("");
  const [applyToAll, setApplyToAll] = React.useState(false);
  const [selectedCandidate, setSelectedCandidate] = React.useState<string | null>(null);

  const queueFn = useServerFn(listIngredientMappingQueueFn);
  const decideFn = useServerFn(decideIngredientMappingFn);
  const historyFn = useServerFn(listMappingDecisionsFn);

  const queue = useQuery({
    queryKey: ["restaurant.recipeMapping", tenantId, { state, recipeId, servicePeriod, search }],
    enabled: Boolean(tenantId),
    queryFn: () =>
      queueFn({
        data: {
          tenantId: tenantId!,
          state,
          recipeId: recipeId || undefined,
          servicePeriod: servicePeriod || undefined,
          search: search || undefined,
          limit: 400,
        },
      }),
  });

  const history = useQuery({
    queryKey: ["restaurant.recipeMapping.history", tenantId, openRow?.lineId],
    enabled: Boolean(tenantId && openRow?.lineId),
    queryFn: () => historyFn({ data: { tenantId: tenantId!, lineId: openRow.lineId, limit: 50 } }),
  });

  const decide = useAdminMutation({
    mutationFn: (vars: {
      lineId: string;
      decision: string;
      inventoryItemId?: string | null;
      applyToMatchingLines?: boolean;
      acknowledgeUnknownUnit?: boolean;
    }) =>
      decideFn({
        data: {
          tenantId: tenantId!,
          lineId: vars.lineId,
          decision: vars.decision as any,
          inventoryItemId: vars.inventoryItemId ?? null,
          note: note.trim() ? note.trim() : null,
          applyToMatchingLines: vars.applyToMatchingLines ?? false,
          acknowledgeUnknownUnit: vars.acknowledgeUnknownUnit ?? false,
        },
      }),
    successMessage: "Mapping decision recorded.",
    onSuccess: () => {
      setNote("");
      setApplyToAll(false);
      void qc.invalidateQueries({ queryKey: ["restaurant.recipeMapping"] });
      void qc.invalidateQueries({ queryKey: ["restaurant.recipeMaster"] });
      void qc.invalidateQueries({ queryKey: ["restaurant.recipeMapping.history"] });
      setOpenRow(null);
    },
  });

  const counts: any = queue.data?.counts ?? {};
  const rows: any[] = React.useMemo(() => queue.data?.rows ?? [], [queue.data]);
  const recipes: any[] = queue.data?.recipes ?? [];

  const openDetail = (row: any) => {
    setOpenRow(row);
    setNote("");
    setApplyToAll(false);
    setSelectedCandidate(
      row.suggestion?.inventoryItemId ?? row.candidates?.[0]?.inventoryItemId ?? null,
    );
  };

  const activeRow = React.useMemo(
    () => rows.find((r) => r.lineId === openRow?.lineId) ?? openRow,
    [rows, openRow],
  );
  const candidate =
    activeRow?.candidates?.find((c: any) => c.inventoryItemId === selectedCandidate) ?? null;

  return (
    <SectionCard
      title="Ingredient mapping"
      description="Reconcile legacy recipe ingredients against the master catalog. Suggestions carry their evidence; only an administrator confirms a mapping, and nothing here creates a stock item."
    >
      <div className="mb-4 flex flex-wrap items-center gap-1 rounded-lg border bg-muted/40 p-1 text-sm">
        {STATE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setState(t.id)}
            className={`rounded-md px-3 py-1.5 ${state === t.id ? "bg-primary text-primary-foreground" : "hover:bg-background"}`}
          >
            {t.label} <span className="opacity-70">({counts[t.countKey] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="h-10 w-56"
          placeholder="Search ingredient or SKU"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          value={servicePeriod}
          onChange={(e) => setServicePeriod(e.target.value)}
        >
          <option value="">All service periods</option>
          <option value="LUNCH">Lunch</option>
          <option value="DINNER">Dinner</option>
        </select>
        <select
          className="h-10 max-w-[16rem] rounded-md border bg-background px-3 text-sm"
          value={recipeId}
          onChange={(e) => setRecipeId(e.target.value)}
        >
          <option value="">All recipes</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} — {r.name}
            </option>
          ))}
        </select>
      </div>

      {queue.isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">Loading ingredient lines…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing in this queue"
          description="No ingredient lines match the current filters."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3">Recipe</th>
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3">Ingredient (as written)</th>
                <th className="py-2 pr-3">Quantity</th>
                <th className="py-2 pr-3">Best candidate</th>
                <th className="py-2 pr-3">Confidence</th>
                <th className="py-2 pr-3">Units</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const top = r.candidates?.[0];
                return (
                  <tr key={r.lineId} className="border-b last:border-0 align-top hover:bg-muted/40">
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.recipeCode}
                      </span>{" "}
                      {r.recipeName}
                    </td>
                    <td className="py-2 pr-3">{r.servicePeriod ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {r.ingredientName}
                      {r.occurrences > 1 ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          · used in {r.occurrences} lines
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{quantityLabel(r)}</td>
                    <td className="py-2 pr-3">
                      {r.mappedItem ? (
                        <>
                          <span className="font-mono text-xs">{r.mappedItem.sku}</span>{" "}
                          {r.mappedItem.name}
                        </>
                      ) : top ? (
                        <>
                          <span className="font-mono text-xs">{top.sku}</span> {top.name}
                        </>
                      ) : (
                        <span className="text-muted-foreground">No catalog candidate</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {top ? (
                        <StatusChip tone={CONFIDENCE_TONE[top.confidence] ?? "neutral"}>
                          {top.confidence}
                        </StatusChip>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {top ? (
                        <StatusChip
                          tone={
                            top.unitCompatible === true
                              ? "success"
                              : top.unitCompatible === false
                                ? "danger"
                                : "warning"
                          }
                        >
                          {top.unitCompatible === true
                            ? "Compatible"
                            : top.unitCompatible === false
                              ? "Incompatible"
                              : "Unknown"}
                        </StatusChip>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusChip
                        tone={
                          r.state === "confirmed"
                            ? "success"
                            : r.state === "review_required"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {r.state === "review_required" ? "Review" : r.state}
                      </StatusChip>
                    </td>
                    <td className="py-2 pr-3">
                      <Button size="sm" variant="outline" onClick={() => openDetail(r)}>
                        Reconcile
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(openRow)} onOpenChange={(o) => !o && setOpenRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{activeRow?.ingredientName}</SheetTitle>
          </SheetHeader>

          {activeRow ? (
            <div className="mt-4 space-y-6 text-sm">
              <div className="rounded-lg border p-3">
                <p className="mb-2 font-medium">Source record (never altered)</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {[
                    ["Recipe", `${activeRow.recipeCode} — ${activeRow.recipeName}`],
                    ["Service period", activeRow.servicePeriod ?? "—"],
                    ["Section", activeRow.sourceSection ?? "—"],
                    ["Ingredient", activeRow.ingredientName],
                    ["Quantity", quantityLabel(activeRow)],
                    ["Original unit", activeRow.sourceUnit ?? "not stated"],
                    ["Workbook candidate SKU", activeRow.candidateSku ?? "—"],
                    ["Source", `${activeRow.sourceFile ?? "—"} row ${activeRow.sourceRow ?? "—"}`],
                    ["Recipe status", activeRow.recipeStatus],
                  ].map(([k, v]) => (
                    <React.Fragment key={String(k)}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium">{String(v)}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>

              {activeRow.suggestion ? (
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                  <p className="font-medium">Previously confirmed for this ingredient text</p>
                  <p className="text-muted-foreground">
                    <span className="font-mono text-xs">{activeRow.suggestion.sku}</span>{" "}
                    {activeRow.suggestion.name} — confirmed for “{activeRow.suggestion.confirmedFor}
                    ”. It is offered as a suggestion and still needs your confirmation here.
                  </p>
                </div>
              ) : null}

              <div>
                <p className="mb-2 font-medium">Catalog candidates</p>
                {(activeRow.candidates ?? []).length === 0 ? (
                  <p className="text-muted-foreground">
                    No catalog item resembles this ingredient. Leave it unresolved or mark it for
                    review — a stock item is never created to satisfy a recipe.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {activeRow.candidates.map((c: any) => (
                      <li key={c.inventoryItemId}>
                        <button
                          type="button"
                          onClick={() => setSelectedCandidate(c.inventoryItemId)}
                          className={`w-full rounded-lg border p-3 text-left ${
                            selectedCandidate === c.inventoryItemId
                              ? "border-primary bg-primary/5"
                              : "hover:bg-muted/50"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {c.sku}
                              </span>{" "}
                              <span className="font-medium">{c.name}</span>
                            </span>
                            <span className="flex gap-1">
                              <StatusChip tone={CONFIDENCE_TONE[c.confidence] ?? "neutral"}>
                                {c.confidence}
                              </StatusChip>
                              <StatusChip
                                tone={
                                  c.unitCompatible === true
                                    ? "success"
                                    : c.unitCompatible === false
                                      ? "danger"
                                      : "warning"
                                }
                              >
                                {c.unitCompatible === true
                                  ? "Units OK"
                                  : c.unitCompatible === false
                                    ? "Unit clash"
                                    : "Unit unknown"}
                              </StatusChip>
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {[c.domain, c.categoryName, c.subcategory]
                              .filter(Boolean)
                              .join(" · ") || "Uncategorised"}{" "}
                            · stock unit {c.stockUnit ?? "—"} · pack {c.packLabel ?? "—"} ·{" "}
                            {c.dataStatus ?? "—"}
                          </p>
                          <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                            {c.evidence.map((e: string) => (
                              <li key={e}>{e}</li>
                            ))}
                          </ul>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-3">
                <Textarea
                  placeholder="Note for the audit trail (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                />
                {activeRow.occurrences > 1 && candidate && candidate.unitCompatible === true ? (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={applyToAll}
                      onCheckedChange={(v) => setApplyToAll(Boolean(v))}
                    />
                    <span>
                      Also apply this confirmation to the other {activeRow.occurrences - 1}{" "}
                      unresolved line(s) using the identical ingredient text and unit.
                    </span>
                  </label>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!candidate || decide.isPending || candidate.unitCompatible === false}
                    onClick={() =>
                      decide.mutate({
                        lineId: activeRow.lineId,
                        decision: "confirmed",
                        inventoryItemId: selectedCandidate,
                        applyToMatchingLines: applyToAll,
                        acknowledgeUnknownUnit: candidate?.unitCompatible === null,
                      })
                    }
                  >
                    {candidate?.unitCompatible === null
                      ? "Confirm mapping (unit unverified)"
                      : "Confirm mapping"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!candidate || decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        lineId: activeRow.lineId,
                        decision: "rejected",
                        inventoryItemId: selectedCandidate,
                      })
                    }
                  >
                    Reject candidate
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ lineId: activeRow.lineId, decision: "left_unresolved" })
                    }
                  >
                    Leave unresolved
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ lineId: activeRow.lineId, decision: "review_required" })
                    }
                  >
                    Mark requires review
                  </Button>
                </div>
                {candidate && candidate.unitCompatible === false ? (
                  <p className="text-xs text-muted-foreground">
                    Confirmation is blocked: the recipe unit (“
                    {activeRow.sourceUnit ?? "not stated"}
                    ”) measures something different from this item's stock unit. Resolve the unit
                    rather than assuming a conversion.
                  </p>
                ) : null}
                {candidate && candidate.unitCompatible === null ? (
                  <p className="text-xs text-muted-foreground">
                    The recipe unit (“{activeRow.sourceUnit ?? "not stated"}”) or this item's stock
                    unit is missing, so the conversion cannot be verified. You may still record the
                    mapping — the line stays in review, and the recipe stays uncostable and inactive
                    until the unit is completed in the master catalog.
                  </p>
                ) : null}
              </div>

              <div>
                <p className="mb-2 font-medium">Decision history</p>
                {(history.data ?? []).length === 0 ? (
                  <p className="text-muted-foreground">No decisions recorded for this line yet.</p>
                ) : (
                  <ul className="divide-y">
                    {(history.data ?? []).map((d: any) => (
                      <li key={d.id} className="py-2 text-xs">
                        <span className="font-medium">{d.decision.replace(/_/g, " ")}</span> ·{" "}
                        {new Date(d.created_at).toLocaleString()} · {d.previous_mapping_status} →{" "}
                        {d.new_mapping_status}
                        {d.applied_to_all ? " · applied in bulk" : ""}
                        {d.note ? ` · “${d.note}”` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </SectionCard>
  );
}
