/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Recipe master import — the CATALOG → RECIPE INGREDIENT → RECIPE spine.
 *
 * This importer establishes recipe *identity, provenance and intent* only. It
 * never creates inventory items, stock, prices or menu items, and it never
 * guesses a mapping. An ingredient the workbook cannot vouch for is stored
 * unresolved, and a recipe holding an unresolved ingredient cannot be
 * activated for live consumption (enforced in the database as well as here).
 *
 * Import safety contract:
 *   • matched on (tenant_id, source_recipe_code, version) — codes are immutable
 *   • unknown recipe      → created as DRAFT
 *   • known + identical   → no-op
 *   • known + different   → conflict recorded, existing recipe untouched
 */
import recipeSource from "./data/legacy-recipe-master.json";
import {
  normaliseRecipe,
  normaliseRecipeLine,
  unitsComparable,
  type NormalisedRecipe,
  type NormalisedRecipeLine,
  type RecipeSourceLine,
  type RecipeSourceRecipe,
} from "./parse";
import { assertCapability, assertTenantRead } from "../core/access.server";

type Sb = any;

const RECIPE_COMPARED_FIELDS = [
  "name",
  "service_period",
  "source_section",
  "portion_basis",
  "instructions",
] as const;
const LINE_COMPARED_FIELDS = [
  "ingredient_name",
  "quantity_min",
  "quantity_max",
  "source_unit",
  "candidate_sku",
] as const;

type MappingStatus = "resolved" | "unresolved" | "review_required";

function numsDiffer(a: unknown, b: unknown) {
  const x = a === null || a === undefined ? null : Number(a);
  const y = b === null || b === undefined ? null : Number(b);
  if (x === null || y === null) return x !== y;
  return Math.abs(x - y) > 1e-6;
}

function differs(field: string, existing: any, incoming: any) {
  if (field === "quantity_min" || field === "quantity_max") return numsDiffer(existing, incoming);
  return (existing ?? null) !== (incoming ?? null);
}

/** Silence in the source asserts nothing; it is a data-quality issue, not a conflict. */
function conflictsFor(fields: readonly string[], existing: any, desired: any) {
  return fields
    .filter((f) => {
      const incoming = desired[f];
      if (incoming === null || incoming === undefined) return false;
      return differs(f, existing[f], incoming);
    })
    .map((f) => ({
      field: f,
      existing: existing[f] ?? null,
      incoming: desired[f] ?? null,
      recommended_action: "Review and confirm which value is authoritative before applying.",
    }));
}

export interface RecipeImportSummary {
  batchId: string;
  sourceFile: string;
  totalRecipes: number;
  totalLines: number;
  recipesCreated: number;
  recipesUnchanged: number;
  recipesConflicted: number;
  linesCreated: number;
  linesUnchanged: number;
  linesConflicted: number;
  linesMatched: number;
  linesUnresolved: number;
  linesReviewRequired: number;
  skipped: number;
  errors: number;
  recipesEligibleForActivation: number;
  recipesInDraftOrReview: number;
  recipesWithCompleteCosting: number;
}

interface Source {
  sourceFile: string;
  sourceLabel: string;
  recipes: RecipeSourceRecipe[];
  lines: RecipeSourceLine[];
}

export function getRecipeSource(): Source {
  return recipeSource as unknown as Source;
}

export async function importRecipeMaster(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId?: string | null; dryRun?: boolean },
): Promise<RecipeImportSummary> {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");

  const source = getRecipeSource();
  const recipes: NormalisedRecipe[] = source.recipes.map(normaliseRecipe);
  const lines: NormalisedRecipeLine[] = source.lines.map(normaliseRecipeLine);
  const linesByRecipe = new Map<string, NormalisedRecipeLine[]>();
  for (const l of lines) {
    const bucket = linesByRecipe.get(l.recipeCode) ?? [];
    bucket.push(l);
    linesByRecipe.set(l.recipeCode, bucket);
  }

  /* -------- reference data (read-only: nothing here is ever created) -------- */
  const { data: unitRows, error: unitErr } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, dimension, factor, tenant_id")
    .or(`tenant_id.is.null,tenant_id.eq.${input.tenantId}`);
  if (unitErr) throw new Error(unitErr.message);
  const unitsByCode = new Map<string, any>();
  const unitsById = new Map<string, any>();
  for (const u of (unitRows ?? []) as any[]) {
    unitsById.set(u.id, u);
    if (!unitsByCode.has(u.code) || u.tenant_id === input.tenantId) unitsByCode.set(u.code, u);
  }

  const candidateSkus = [...new Set(lines.map((l) => l.candidateSku).filter(Boolean) as string[])];
  const itemsBySku = new Map<string, any>();
  if (candidateSkus.length) {
    const { data: items, error } = await sb
      .from("restaurant_inventory_items")
      .select("id, sku, name, unit_id, status")
      .eq("tenant_id", input.tenantId)
      .in("sku", candidateSkus);
    if (error) throw new Error(error.message);
    for (const i of (items ?? []) as any[]) itemsBySku.set(i.sku, i);
  }

  const { data: existingRecipes, error: recErr } = await sb
    .from("restaurant_recipes")
    .select(
      "id, code, name, version, status, service_period, source_section, portion_basis, instructions, source_recipe_code",
    )
    .eq("tenant_id", input.tenantId)
    .in(
      "source_recipe_code",
      recipes.map((r) => r.code),
    );
  if (recErr) throw new Error(recErr.message);
  const existingByKey = new Map<string, any>(
    ((existingRecipes ?? []) as any[]).map((r) => [`${r.source_recipe_code}@${r.version}`, r]),
  );

  /* ---------------------------- batch header ---------------------------- */
  const { data: batch, error: batchErr } = await sb
    .from("restaurant_recipe_import_batches")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      source_file: source.sourceFile,
      source_label: source.sourceLabel,
      status: input.dryRun ? "dry_run" : "running",
      total_recipes: recipes.length,
      total_lines: lines.length,
      imported_by: userId,
    })
    .select("id")
    .single();
  if (batchErr) throw new Error(batchErr.message);
  const batchId = batch.id as string;

  const counts = {
    recipesCreated: 0,
    recipesUnchanged: 0,
    recipesConflicted: 0,
    linesCreated: 0,
    linesUnchanged: 0,
    linesConflicted: 0,
    linesMatched: 0,
    linesUnresolved: 0,
    linesReviewRequired: 0,
    skipped: 0,
    errors: 0,
  };
  const audit: any[] = [];
  const recipeIdsTouched: string[] = [];

  /** Resolve a source line to a stock item — or refuse to. */
  function resolveMapping(line: NormalisedRecipeLine) {
    const issues = [...line.issues];
    const recipeUnit = line.unitCode ? unitsByCode.get(line.unitCode) : null;

    if (!line.candidateSku) {
      return {
        itemId: null as string | null,
        unitId: recipeUnit?.id ?? null,
        status: "unresolved" as MappingStatus,
        issues,
      };
    }
    const item = itemsBySku.get(line.candidateSku);
    if (!item) {
      issues.push(
        `Candidate SKU "${line.candidateSku}" is not in the master catalog. No stock item was created.`,
      );
      return {
        itemId: null,
        unitId: recipeUnit?.id ?? null,
        status: "review_required" as MappingStatus,
        issues,
      };
    }
    const itemUnit = item.unit_id ? unitsById.get(item.unit_id) : null;
    if (!unitsComparable(recipeUnit, itemUnit)) {
      issues.push(
        `Recipe unit "${line.sourceUnit ?? "—"}" cannot be converted to the stock unit of ${item.sku} without a new conversion rule.`,
      );
      return {
        itemId: null,
        unitId: recipeUnit?.id ?? null,
        status: "review_required" as MappingStatus,
        issues,
      };
    }
    return {
      itemId: item.id as string,
      unitId: recipeUnit?.id ?? null,
      status: "resolved" as MappingStatus,
      issues,
    };
  }

  for (const r of recipes) {
    const key = `${r.code}@${r.version}`;
    const existing = existingByKey.get(key);
    const desiredRecipe = {
      name: r.name,
      service_period: r.servicePeriod,
      source_section: r.sourceSection,
      portion_basis: r.portionBasis,
      instructions: r.instructions,
    };
    const recipeAudit: any = {
      tenant_id: input.tenantId,
      batch_id: batchId,
      entity_type: "recipe",
      source_row: r.sourceRow,
      recipe_code: r.code,
      recipe_name: r.name,
      source_values: { ...r },
      result: "skipped",
      message: null,
      conflicts: [],
      recipe_id: null,
      review_status: "none",
    };

    let recipeId: string | null = existing?.id ?? null;
    try {
      if (!existing) {
        if (input.dryRun) {
          recipeAudit.result = "created";
          counts.recipesCreated += 1;
        } else {
          const { data: inserted, error } = await sb
            .from("restaurant_recipes")
            .insert({
              tenant_id: input.tenantId,
              property_id: input.propertyId ?? null,
              code: r.code,
              name: r.name,
              version: r.version,
              kind: "menu",
              status: "draft",
              yield_quantity: 1,
              yield_unit_id: unitsByCode.get("portion")?.id ?? null,
              instructions: r.instructions,
              currency: "TZS",
              service_period: r.servicePeriod,
              source_section: r.sourceSection,
              portion_basis: r.portionBasis,
              source_recipe_code: r.code,
              source_file: r.sourceFile,
              source_sheet: r.sourceSheet,
              import_status: r.importStatus,
              import_batch_id: batchId,
              created_by: userId,
            })
            .select("id")
            .single();
          if (error) throw new Error(error.message);
          recipeId = inserted.id as string;
          await sb.from("restaurant_recipes").update({ lineage_id: recipeId }).eq("id", recipeId);
          recipeAudit.result = "created";
          counts.recipesCreated += 1;
        }
      } else {
        const conflicts = conflictsFor(RECIPE_COMPARED_FIELDS, existing, desiredRecipe);
        if (conflicts.length === 0) {
          recipeAudit.result = "unchanged";
          counts.recipesUnchanged += 1;
        } else {
          recipeAudit.result = "conflict";
          recipeAudit.conflicts = conflicts;
          recipeAudit.review_status = "REVIEW_REQUIRED";
          recipeAudit.message = `${conflicts.length} field(s) differ from the existing recipe version. Not overwritten.`;
          counts.recipesConflicted += 1;
        }
      }
      recipeAudit.recipe_id = recipeId;
    } catch (err) {
      recipeAudit.result = "error";
      recipeAudit.message = err instanceof Error ? err.message : String(err);
      recipeAudit.review_status = "REVIEW_REQUIRED";
      counts.errors += 1;
    }
    audit.push(recipeAudit);
    if (recipeId) recipeIdsTouched.push(recipeId);

    /* ------------------------------ lines ------------------------------ */
    const sourceLines = linesByRecipe.get(r.code) ?? [];
    let existingLines: any[] = [];
    if (recipeId && !input.dryRun) {
      const { data } = await sb
        .from("restaurant_recipe_lines")
        .select(
          "id, source_row, ingredient_name, quantity, quantity_min, quantity_max, source_unit, candidate_sku, inventory_item_id, mapping_status",
        )
        .eq("tenant_id", input.tenantId)
        .eq("recipe_id", recipeId);
      existingLines = (data ?? []) as any[];
    }
    const existingLineByRow = new Map<number, any>(
      existingLines.map((l) => [Number(l.source_row), l]),
    );

    for (const line of sourceLines) {
      const mapping = resolveMapping(line);
      if (mapping.status === "resolved") counts.linesMatched += 1;
      else if (mapping.status === "unresolved") counts.linesUnresolved += 1;
      else counts.linesReviewRequired += 1;

      const desiredLine = {
        ingredient_name: line.ingredientName,
        quantity_min: line.quantityMin,
        quantity_max: line.quantityMax,
        source_unit: line.sourceUnit,
        candidate_sku: line.candidateSku,
      };
      const lineAudit: any = {
        tenant_id: input.tenantId,
        batch_id: batchId,
        entity_type: "recipe_line",
        source_row: line.sourceRow,
        recipe_code: line.recipeCode,
        recipe_name: r.name,
        ingredient_name: line.ingredientName,
        candidate_sku: line.candidateSku,
        mapping_result: mapping.status,
        source_values: { ...line, issues: mapping.issues },
        result: "skipped",
        message: mapping.issues.length ? mapping.issues.join(" ") : null,
        conflicts: [],
        recipe_id: recipeId,
        recipe_line_id: null,
        inventory_item_id: mapping.itemId,
        review_status:
          mapping.status === "resolved" && mapping.issues.length === 0 ? "none" : "REVIEW_REQUIRED",
      };

      try {
        if (!recipeId || input.dryRun) {
          lineAudit.result = input.dryRun ? "created" : "skipped";
          if (input.dryRun) counts.linesCreated += 1;
          else counts.skipped += 1;
        } else {
          const existingLine = existingLineByRow.get(line.sourceRow);
          if (!existingLine) {
            const { data: inserted, error } = await sb
              .from("restaurant_recipe_lines")
              .insert({
                tenant_id: input.tenantId,
                recipe_id: recipeId,
                component_kind: "inventory_item",
                inventory_item_id: mapping.itemId,
                quantity: line.quantity,
                unit_id: mapping.unitId,
                yield_percent: 100,
                is_optional: false,
                sort_order: line.sourceRow,
                notes: line.notes,
                ingredient_name: line.ingredientName,
                quantity_min: line.quantityMin,
                quantity_max: line.quantityMax,
                source_unit: line.sourceUnit,
                candidate_sku: line.candidateSku,
                mapping_status: mapping.status,
                source_file: line.sourceFile,
                source_sheet: line.sourceSheet,
                source_row: line.sourceRow,
                import_batch_id: batchId,
              })
              .select("id")
              .single();
            if (error) throw new Error(error.message);
            lineAudit.recipe_line_id = inserted.id;
            lineAudit.result = "created";
            counts.linesCreated += 1;
          } else {
            const conflicts = conflictsFor(LINE_COMPARED_FIELDS, existingLine, desiredLine);
            lineAudit.recipe_line_id = existingLine.id;
            if (conflicts.length === 0) {
              lineAudit.result = "unchanged";
              counts.linesUnchanged += 1;
            } else {
              lineAudit.result = "conflict";
              lineAudit.conflicts = conflicts;
              lineAudit.review_status = "REVIEW_REQUIRED";
              lineAudit.message = `${conflicts.length} field(s) differ from the existing recipe line. Not overwritten.`;
              counts.linesConflicted += 1;
            }
          }
        }
      } catch (err) {
        lineAudit.result = "error";
        lineAudit.message = err instanceof Error ? err.message : String(err);
        lineAudit.review_status = "REVIEW_REQUIRED";
        counts.errors += 1;
      }
      audit.push(lineAudit);
    }
  }

  const { error: auditErr } = await sb.from("restaurant_recipe_import_rows").insert(audit);
  if (auditErr) throw new Error(auditErr.message);

  const readiness = await recipeReadiness(sb, input.tenantId);

  const { error: updErr } = await sb
    .from("restaurant_recipe_import_batches")
    .update({
      status: input.dryRun ? "dry_run" : "completed",
      recipes_created: counts.recipesCreated,
      recipes_unchanged: counts.recipesUnchanged,
      recipes_conflicted: counts.recipesConflicted,
      lines_created: counts.linesCreated,
      lines_unchanged: counts.linesUnchanged,
      lines_conflicted: counts.linesConflicted,
      lines_matched: counts.linesMatched,
      lines_unresolved: counts.linesUnresolved,
      lines_review_required: counts.linesReviewRequired,
      skipped_count: counts.skipped,
      error_count: counts.errors,
    })
    .eq("id", batchId)
    .eq("tenant_id", input.tenantId);
  if (updErr) throw new Error(updErr.message);

  return {
    batchId,
    sourceFile: source.sourceFile,
    totalRecipes: recipes.length,
    totalLines: lines.length,
    ...counts,
    ...readiness,
  };
}

/* ---------------- Readiness & reads ---------------- */

/**
 * A recipe is eligible for activation only when every ingredient line resolves
 * to a stock item; costing is "complete" under exactly the same condition,
 * because an unresolved ingredient contributes an unknown, not a zero.
 */
export async function recipeReadiness(sb: Sb, tenantId: string) {
  const { data: recipes } = await sb
    .from("restaurant_recipes")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .not("source_recipe_code", "is", null);
  const { data: lines } = await sb
    .from("restaurant_recipe_lines")
    .select("recipe_id, mapping_status")
    .eq("tenant_id", tenantId);

  const unresolvedByRecipe = new Map<string, number>();
  const totalByRecipe = new Map<string, number>();
  for (const l of (lines ?? []) as any[]) {
    totalByRecipe.set(l.recipe_id, (totalByRecipe.get(l.recipe_id) ?? 0) + 1);
    if (l.mapping_status !== "resolved")
      unresolvedByRecipe.set(l.recipe_id, (unresolvedByRecipe.get(l.recipe_id) ?? 0) + 1);
  }

  let eligible = 0;
  let draft = 0;
  for (const r of (recipes ?? []) as any[]) {
    const unresolved = unresolvedByRecipe.get(r.id) ?? 0;
    const total = totalByRecipe.get(r.id) ?? 0;
    if (total > 0 && unresolved === 0) eligible += 1;
    if (r.status !== "active") draft += 1;
  }
  return {
    recipesEligibleForActivation: eligible,
    recipesInDraftOrReview: draft,
    recipesWithCompleteCosting: eligible,
  };
}

export interface ListImportedRecipesInput {
  tenantId: string;
  search?: string;
  servicePeriod?: string;
  status?: string;
  completeness?: "complete" | "incomplete";
  limit?: number;
}

export async function listImportedRecipes(sb: Sb, userId: string, input: ListImportedRecipesInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_recipes")
    .select(
      "id, code, name, version, status, service_period, source_section, portion_basis, instructions, source_file, source_sheet, source_recipe_code, import_status, computed_cost, currency, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .not("source_recipe_code", "is", null)
    .order("code")
    .limit(input.limit ?? 500);
  if (input.servicePeriod) q = q.eq("service_period", input.servicePeriod);
  if (input.status) q = q.eq("status", input.status);
  if (input.search) q = q.or(`name.ilike.%${input.search}%,code.ilike.%${input.search}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const recipes = (data ?? []) as any[];

  const ids = recipes.map((r) => r.id);
  let lines: any[] = [];
  if (ids.length) {
    const { data: lineRows } = await sb
      .from("restaurant_recipe_lines")
      .select(
        "id, recipe_id, ingredient_name, quantity, quantity_min, quantity_max, source_unit, unit_id, candidate_sku, inventory_item_id, mapping_status, notes, source_row",
      )
      .eq("tenant_id", input.tenantId)
      .in("recipe_id", ids)
      .order("sort_order");
    lines = (lineRows ?? []) as any[];
  }

  const decorated = recipes.map((r) => {
    const own = lines.filter((l) => l.recipe_id === r.id);
    const unresolved = own.filter((l) => l.mapping_status !== "resolved").length;
    return {
      ...r,
      lineCount: own.length,
      unresolvedCount: unresolved,
      costingComplete: own.length > 0 && unresolved === 0,
      eligibleForActivation: own.length > 0 && unresolved === 0,
      lines: own,
    };
  });
  const filtered =
    input.completeness === "complete"
      ? decorated.filter((r) => r.costingComplete)
      : input.completeness === "incomplete"
        ? decorated.filter((r) => !r.costingComplete)
        : decorated;
  return { recipes: filtered, readiness: await recipeReadiness(sb, input.tenantId) };
}

export async function listRecipeImportBatches(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_import_batches")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("imported_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listRecipeReviewQueue(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    batchId?: string;
    entityType?: string;
    includeResolved?: boolean;
    limit?: number;
  },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_recipe_import_rows")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("source_row")
    .limit(input.limit ?? 600);
  if (input.batchId) q = q.eq("batch_id", input.batchId);
  if (input.entityType) q = q.eq("entity_type", input.entityType);
  if (!input.includeResolved) q = q.eq("review_status", "REVIEW_REQUIRED");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function resolveRecipeReviewRow(
  sb: Sb,
  userId: string,
  input: { tenantId: string; rowId: string; note?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");
  const { data, error } = await sb
    .from("restaurant_recipe_import_rows")
    .update({
      review_status: "resolved",
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      ...(input.note ? { message: input.note } : {}),
    })
    .eq("id", input.rowId)
    .eq("tenant_id", input.tenantId)
    .select("id, review_status")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Administrator resolution of an ingredient mapping. Source provenance
 * (candidate SKU, source unit, quantities, file/row) is deliberately left
 * untouched — only the decision is recorded.
 */
export async function mapRecipeLineToItem(
  sb: Sb,
  userId: string,
  input: { tenantId: string; lineId: string; inventoryItemId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");
  const { data: line } = await sb
    .from("restaurant_recipe_lines")
    .select("id, unit_id, source_unit")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.lineId)
    .single();
  if (!line) throw new Error("Recipe line not found.");

  const { data: item } = await sb
    .from("restaurant_inventory_items")
    .select("id, sku, unit_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.inventoryItemId)
    .single();
  if (!item) throw new Error("Stock item not found in this tenant's master catalog.");

  const { data: units } = await sb
    .from("restaurant_inventory_units")
    .select("id, dimension")
    .in("id", [line.unit_id, item.unit_id].filter(Boolean));
  const byId = new Map<string, any>(((units ?? []) as any[]).map((u) => [u.id, u]));
  const recipeUnit = line.unit_id ? byId.get(line.unit_id) : null;
  const itemUnit = item.unit_id ? byId.get(item.unit_id) : null;
  if (!recipeUnit || !itemUnit || recipeUnit.dimension !== itemUnit.dimension) {
    throw new Error(
      `The recipe unit ("${line.source_unit ?? "—"}") cannot be converted to the stock unit of ${item.sku}. Resolve the unit before mapping.`,
    );
  }

  const { data, error } = await sb
    .from("restaurant_recipe_lines")
    .update({ inventory_item_id: item.id, mapping_status: "resolved" })
    .eq("id", input.lineId)
    .eq("tenant_id", input.tenantId)
    .select("id, inventory_item_id, mapping_status")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
