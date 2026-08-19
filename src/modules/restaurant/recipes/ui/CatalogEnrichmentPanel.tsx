/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Catalog enrichment: missing master catalog items and missing stock units.
 *
 * Two review queues, both governed. An item reaches the catalog only after
 * REVIEW → APPROVE → CREATE, each step recorded with its evidence. A stock
 * unit is only ever added where none exists; an established unit is never
 * restated here, because that would silently reprice existing stock.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  createCatalogItemFromRequestFn,
  listEnrichmentDecisionsFn,
  listMissingCatalogItemsFn,
  listStockUnitGapsFn,
  markStockUnitUnresolvedFn,
  reviewCatalogItemRequestFn,
  setCatalogStockUnitFn,
} from "../enrichment.functions";

const REQUEST_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  created: "success",
  approved: "warning",
  rejected: "danger",
  proposed: "neutral",
};

function skuCodeFrom(text: string) {
  return (text || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3)
    .padEnd(3, "X");
}

/* ------------------------------------------------------------------ */

export function MissingCatalogItemsPanel({ tenantId }: { tenantId: string | undefined }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listMissingCatalogItemsFn);
  const reviewFn = useServerFn(reviewCatalogItemRequestFn);
  const createFn = useServerFn(createCatalogItemFromRequestFn);

  const [openRow, setOpenRow] = React.useState<any | null>(null);
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("FNB");
  const [category, setCategory] = React.useState("");
  const [subcategory, setSubcategory] = React.useState("");
  const [skuCode, setSkuCode] = React.useState("");
  const [stockUnit, setStockUnit] = React.useState("");
  const [purchaseUnit, setPurchaseUnit] = React.useState("");
  const [note, setNote] = React.useState("");

  const queue = useQuery({
    queryKey: ["restaurant.missingCatalogItems", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => listFn({ data: { tenantId: tenantId! } }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["restaurant.missingCatalogItems", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.gapAnalysis", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.stockUnitGaps", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.enrichmentDecisions", tenantId] });
  };

  const review = useAdminMutation({
    mutationFn: reviewFn as any,
    successMessage: "Decision recorded.",
    onSuccess: invalidate,
  });
  const create = useAdminMutation({
    mutationFn: createFn as any,
    successMessage: "Catalog item created.",
    onSuccess: () => {
      invalidate();
      setOpenRow(null);
    },
  });

  const data: any = queue.data;
  const rows: any[] = data?.rows ?? [];
  const units: any[] = data?.units ?? [];

  function open(row: any) {
    setOpenRow(row);
    setName(row.ingredientName ?? "");
    setDomain(row.suggestedDomain ?? "FNB");
    setCategory(row.suggestedCategory ?? "");
    setSubcategory(row.suggestedSubcategory ?? "");
    setSkuCode(skuCodeFrom(row.suggestedCategory ?? row.ingredientName ?? ""));
    setStockUnit(row.suggestedStockUnitCode ?? "");
    setPurchaseUnit("");
    setNote("");
  }

  function approve(row: any) {
    review.mutate({
      data: {
        tenantId: tenantId!,
        ingredientKey: row.ingredientKey,
        ingredientName: row.ingredientName,
        occurrences: row.occurrences,
        decision: "approve",
        suggestedDomain: row.suggestedDomain ?? null,
        suggestedCategory: row.suggestedCategory ?? null,
        suggestedSubcategory: row.suggestedSubcategory ?? null,
        suggestedStockUnitCode: row.suggestedStockUnitCode ?? null,
        provenance: { sources: (row.sources ?? []).slice(0, 20), recipes: row.recipes ?? [] },
      },
    } as any);
  }

  function reject(row: any) {
    review.mutate({
      data: {
        tenantId: tenantId!,
        ingredientKey: row.ingredientKey,
        ingredientName: row.ingredientName,
        occurrences: row.occurrences,
        decision: "reject",
      },
    } as any);
  }

  return (
    <SectionCard
      title="Missing master catalog items"
      description="Ingredients the recipe books require that the catalog does not contain. Review the evidence, approve, then create — nothing is created silently, and an existing item is never duplicated."
    >
      {rows.length === 0 ? (
        <EmptyState
          title={queue.isLoading ? "Loading…" : "No missing ingredients"}
          description="Every recipe ingredient has at least a plausible catalog candidate."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3">Ingredient</th>
                <th className="py-2 pr-3">Lines</th>
                <th className="py-2 pr-3">Recipes</th>
                <th className="py-2 pr-3">Suggested unit</th>
                <th className="py-2 pr-3">Nearest catalog items</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ingredientKey} className="border-b align-top last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{r.ingredientName}</div>
                    <div className="text-xs text-muted-foreground">
                      {(r.quantities ?? []).join(" · ") || "no quantity recorded"}
                    </div>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{r.occurrences}</td>
                  <td className="py-2 pr-3 text-xs">
                    {(r.recipes ?? []).slice(0, 3).map((x: any) => x.code ?? x.name).join(", ")}
                    {(r.recipes ?? []).length > 3 ? ` +${r.recipes.length - 3}` : ""}
                  </td>
                  <td className="py-2 pr-3">
                    {r.suggestedStockUnitCode ?? "—"}
                    <div className="text-xs text-muted-foreground">{r.suggestedStockUnitReason}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {(r.nearestCatalogItems ?? []).length === 0
                      ? "none"
                      : r.nearestCatalogItems.map((n: any) => `${n.sku} ${n.name} (${n.score})`).join(" · ")}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusChip tone={REQUEST_TONE[r.request?.status ?? "proposed"] ?? "neutral"}>
                      {r.request?.status ?? "not reviewed"}
                    </StatusChip>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex justify-end gap-2">
                      {r.request?.status === "approved" ? (
                        <Button size="sm" onClick={() => open(r)}>
                          Create item
                        </Button>
                      ) : r.request?.status === "created" ? (
                        <span className="font-mono text-xs">{r.request.createdSku}</span>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => reject(r)} disabled={review.isPending}>
                            Reject
                          </Button>
                          <Button size="sm" onClick={() => approve(r)} disabled={review.isPending}>
                            Approve
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(data?.settled ?? []).length > 0 && (
        <div className="mt-6 text-xs text-muted-foreground">
          Settled requests:{" "}
          {data.settled
            .map((s: any) => `${s.ingredientName} (${s.status}${s.createdSku ? ` → ${s.createdSku}` : ""})`)
            .join(" · ")}
        </div>
      )}

      <Sheet open={Boolean(openRow)} onOpenChange={(o) => !o && setOpenRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Create catalog item</SheetTitle>
          </SheetHeader>
          {openRow && (
            <div className="mt-4 space-y-3 text-sm">
              <p className="text-muted-foreground">
                Creates identity and configuration only: no opening balance, no cost, no movement.
              </p>
              <label className="block">
                Name
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  Domain
                  <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
                </label>
                <label className="block">
                  SKU category code (2–4 letters)
                  <Input value={skuCode} onChange={(e) => setSkuCode(e.target.value.toUpperCase())} />
                </label>
                <label className="block">
                  Category
                  <Input value={category} onChange={(e) => setCategory(e.target.value)} />
                </label>
                <label className="block">
                  Subcategory
                  <Input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} />
                </label>
                <label className="block">
                  Stock unit
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2"
                    value={stockUnit}
                    onChange={(e) => setStockUnit(e.target.value)}
                  >
                    <option value="">Leave unrecorded</option>
                    {units.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.code} — {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  Purchase unit
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2"
                    value={purchaseUnit}
                    onChange={(e) => setPurchaseUnit(e.target.value)}
                  >
                    <option value="">Same as stock</option>
                    {units.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.code} — {u.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                Note
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </label>
              <Button
                className="w-full"
                disabled={create.isPending || !name || skuCode.length < 2}
                onClick={() =>
                  create.mutate({
                    data: {
                      tenantId: tenantId!,
                      requestId: openRow.request.id,
                      name,
                      domain,
                      categoryName: category || null,
                      subcategory: subcategory || null,
                      skuCode,
                      stockUnitCode: stockUnit || null,
                      purchaseUnitCode: purchaseUnit || null,
                      note: note || null,
                    },
                  } as any)
                }
              >
                Create catalog item
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */

export function StockUnitCompletenessPanel({ tenantId }: { tenantId: string | undefined }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStockUnitGapsFn);
  const setFn = useServerFn(setCatalogStockUnitFn);
  const unresolvedFn = useServerFn(markStockUnitUnresolvedFn);
  const [choice, setChoice] = React.useState<Record<string, string>>({});

  const gaps = useQuery({
    queryKey: ["restaurant.stockUnitGaps", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => listFn({ data: { tenantId: tenantId! } }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["restaurant.stockUnitGaps", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.gapAnalysis", tenantId] });
    qc.invalidateQueries({ queryKey: ["restaurant.enrichmentDecisions", tenantId] });
  };

  const confirm = useAdminMutation({
    mutationFn: setFn as any,
    successMessage: "Stock unit confirmed.",
    onSuccess: invalidate,
  });
  const markUnresolved = useAdminMutation({
    mutationFn: unresolvedFn as any,
    successMessage: "Recorded as unresolved.",
    onSuccess: invalidate,
  });

  const data: any = gaps.data;
  const rows: any[] = data?.rows ?? [];
  const units: any[] = data?.units ?? [];

  return (
    <SectionCard
      title="Stock unit completeness"
      description="Catalog items with no stock unit cannot be costed or counted. Suggestions come from the purchase unit, pack size and recipe usage — each one is confirmed by a person."
    >
      {rows.length === 0 ? (
        <EmptyState
          title={gaps.isLoading ? "Loading…" : "Every catalog item has a stock unit"}
          description={data ? `${data.catalogSize} items checked.` : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3">SKU</th>
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3">Purchase unit / pack</th>
                <th className="py-2 pr-3">Recipes affected</th>
                <th className="py-2 pr-3">Suggestion</th>
                <th className="py-2 pr-3 text-right">Confirm</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const value = choice[r.itemId] ?? r.suggestedStockUnit ?? "";
                return (
                  <tr key={r.itemId} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{r.sku}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[r.categoryName, r.subcategory].filter(Boolean).join(" · ") || "uncategorised"}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {r.purchaseUnit ?? "—"} {r.packLabel ? `· ${r.packLabel}` : ""}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {r.affectedRecipes.length === 0
                        ? "none"
                        : `${r.affectedRecipes.length}: ${r.affectedRecipes.slice(0, 3).join(", ")}`}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusChip tone={r.suggestedStockUnit ? "warning" : "neutral"}>{r.state}</StatusChip>
                      <div className="mt-1 text-xs text-muted-foreground">{r.reason}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-2">
                        <select
                          className="h-9 rounded-md border bg-background px-2 text-xs"
                          value={value}
                          onChange={(e) => setChoice((c) => ({ ...c, [r.itemId]: e.target.value }))}
                        >
                          <option value="">Select unit</option>
                          {units.map((u) => (
                            <option key={u.code} value={u.code}>
                              {u.code} — {u.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          disabled={!value || confirm.isPending}
                          onClick={() =>
                            confirm.mutate({
                              data: { tenantId: tenantId!, itemId: r.itemId, unitCode: value },
                            } as any)
                          }
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={markUnresolved.isPending}
                          onClick={() =>
                            markUnresolved.mutate({
                              data: { tenantId: tenantId!, itemId: r.itemId },
                            } as any)
                          }
                        >
                          Unresolved
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */

export function EnrichmentAuditPanel({ tenantId }: { tenantId: string | undefined }) {
  const fn = useServerFn(listEnrichmentDecisionsFn);
  const audit = useQuery({
    queryKey: ["restaurant.enrichmentDecisions", tenantId],
    enabled: Boolean(tenantId),
    queryFn: () => fn({ data: { tenantId: tenantId!, limit: 200 } }),
  });
  const rows: any[] = (audit.data as any) ?? [];

  return (
    <SectionCard title="Enrichment audit trail" description="Every review, approval, creation and stock-unit confirmation, with who decided it and when.">
      {rows.length === 0 ? (
        <EmptyState title="No enrichment decisions yet" description="Decisions appear here as soon as the queues are worked." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Decision</th>
                <th className="py-2 pr-3">Subject</th>
                <th className="py-2 pr-3">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 text-xs">{new Date(d.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-3">
                    <StatusChip tone={d.decision === "request_rejected" ? "danger" : "neutral"}>
                      {String(d.decision).replace(/_/g, " ")}
                    </StatusChip>
                  </td>
                  <td className="py-2 pr-3">{d.sku ?? d.ingredient_name ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{d.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}