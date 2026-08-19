/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Ingredient mapping workbench — reconciling legacy recipe ingredients against
 * the master catalog, one deliberate human decision at a time.
 *
 * Non-negotiables enforced here:
 *   • no inventory item is ever created to satisfy a recipe
 *   • nothing ambiguous is mapped silently — a confirmation is always a person
 *   • the original source values (ingredient text, quantities, unit, candidate
 *     SKU, file/row) are never rewritten; only the decision is stored
 *   • every decision is appended to a permanent audit trail
 *   • recipes stay draft; activation remains governed by the database guard
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { ingredientKey, scoreCandidate, type MappingConfidence } from "./mapping";

type Sb = any;

export type MappingDecision = "confirmed" | "rejected" | "left_unresolved" | "review_required";

const LINE_SELECT =
  "id, recipe_id, ingredient_name, quantity, quantity_min, quantity_max, source_unit, unit_id, candidate_sku, inventory_item_id, mapping_status, notes, sort_order, source_file, source_row";

async function loadReference(sb: Sb, tenantId: string) {
  const [{ data: items }, { data: units }, { data: categories }, { data: aliases }] =
    await Promise.all([
      sb
        .from("restaurant_inventory_items")
        .select("id, sku, name, domain, subcategory, category_id, unit_id, pack_label, data_status")
        .eq("tenant_id", tenantId)
        .order("sku"),
      sb
        .from("restaurant_inventory_units")
        .select("id, code, name, dimension")
        .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`),
      sb.from("restaurant_inventory_categories").select("id, name").eq("tenant_id", tenantId),
      sb
        .from("restaurant_recipe_ingredient_aliases")
        .select(
          "id, ingredient_key, ingredient_name, inventory_item_id, status, confidence, note, updated_at",
        )
        .eq("tenant_id", tenantId),
    ]);

  const unitById = new Map<string, any>(((units ?? []) as any[]).map((u) => [u.id, u]));
  const categoryById = new Map<string, any>(((categories ?? []) as any[]).map((c) => [c.id, c]));
  const confirmed = new Map<string, any>();
  const rejected = new Set<string>();
  for (const a of (aliases ?? []) as any[]) {
    if (a.status === "confirmed") confirmed.set(a.ingredient_key, a);
    else rejected.add(`${a.ingredient_key}::${a.inventory_item_id}`);
  }
  return {
    items: (items ?? []) as any[],
    unitById,
    categoryById,
    confirmed,
    rejected,
    aliases: (aliases ?? []) as any[],
  };
}

function unitCompatibility(
  unitById: Map<string, any>,
  lineUnitId: string | null,
  itemUnitId: string | null,
) {
  const a = lineUnitId ? unitById.get(lineUnitId) : null;
  const b = itemUnitId ? unitById.get(itemUnitId) : null;
  if (!a || !b) return null;
  return a.dimension === b.dimension;
}

export interface MappingQueueInput {
  tenantId: string;
  /** Which mapping states to show. */
  state?: "unmapped" | "suggested" | "confirmed" | "review_required" | "all";
  recipeId?: string;
  servicePeriod?: string;
  search?: string;
  limit?: number;
}

export interface MappingCandidate {
  inventoryItemId: string;
  sku: string;
  name: string;
  domain: string | null;
  categoryName: string | null;
  subcategory: string | null;
  stockUnit: string | null;
  packLabel: string | null;
  dataStatus: string | null;
  score: number;
  confidence: MappingConfidence;
  evidence: string[];
  unitCompatible: boolean | null;
  fromWorkbook: boolean;
  previouslyConfirmed: boolean;
}

/**
 * Every imported ingredient line with its candidates, evidence and current
 * decision. Candidates are ranked suggestions, never applied mappings.
 */
export async function listIngredientMappingQueue(sb: Sb, userId: string, input: MappingQueueInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  const ref = await loadReference(sb, input.tenantId);

  let recipeQ = sb
    .from("restaurant_recipes")
    .select("id, code, name, status, service_period, source_section, source_recipe_code")
    .eq("tenant_id", input.tenantId)
    .not("source_recipe_code", "is", null)
    .order("code");
  if (input.recipeId) recipeQ = recipeQ.eq("id", input.recipeId);
  if (input.servicePeriod) recipeQ = recipeQ.eq("service_period", input.servicePeriod);
  const { data: recipeRows, error: recipeErr } = await recipeQ;
  if (recipeErr) throw new Error(recipeErr.message);
  const recipes = (recipeRows ?? []) as any[];
  const recipeById = new Map<string, any>(recipes.map((r) => [r.id, r]));
  if (recipes.length === 0)
    return { rows: [], counts: emptyCounts(), recipes: [], catalogSize: ref.items.length };

  const { data: lineRows, error: lineErr } = await sb
    .from("restaurant_recipe_lines")
    .select(LINE_SELECT)
    .eq("tenant_id", input.tenantId)
    .in("recipe_id", Array.from(recipeById.keys()))
    .order("sort_order");
  if (lineErr) throw new Error(lineErr.message);

  const search = input.search?.trim().toLowerCase() ?? "";
  const itemById = new Map<string, any>(ref.items.map((i) => [i.id, i]));

  const rows = ((lineRows ?? []) as any[])
    .filter(
      (l) =>
        !search ||
        (l.ingredient_name ?? "").toLowerCase().includes(search) ||
        (l.candidate_sku ?? "").toLowerCase().includes(search),
    )
    .map((l) => {
      const recipe = recipeById.get(l.recipe_id);
      const key = ingredientKey(l.ingredient_name);
      const alias = ref.confirmed.get(key) ?? null;

      const candidates: MappingCandidate[] = ref.items
        .map((item) => {
          const compat = unitCompatibility(ref.unitById, l.unit_id, item.unit_id);
          const categoryName = item.category_id
            ? (ref.categoryById.get(item.category_id)?.name ?? null)
            : null;
          const scored = scoreCandidate({
            ingredientName: l.ingredient_name,
            candidateSku: l.candidate_sku,
            item: { sku: item.sku, name: item.name, subcategory: item.subcategory, categoryName },
            previouslyConfirmed: alias?.inventory_item_id === item.id,
            previouslyRejected: ref.rejected.has(`${key}::${item.id}`),
            unitCompatible: compat,
          });
          return {
            inventoryItemId: item.id,
            sku: item.sku,
            name: item.name,
            domain: item.domain ?? null,
            categoryName,
            subcategory: item.subcategory ?? null,
            stockUnit: item.unit_id ? (ref.unitById.get(item.unit_id)?.code ?? null) : null,
            packLabel: item.pack_label ?? null,
            dataStatus: item.data_status ?? null,
            unitCompatible: compat,
            fromWorkbook: Boolean(
              l.candidate_sku && l.candidate_sku.toUpperCase() === String(item.sku).toUpperCase(),
            ),
            previouslyConfirmed: alias?.inventory_item_id === item.id,
            ...scored,
          } as MappingCandidate;
        })
        .filter((c) => c.score > 0.15 || c.fromWorkbook || c.previouslyConfirmed)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      const mapped = l.inventory_item_id ? itemById.get(l.inventory_item_id) : null;
      const state: "confirmed" | "review_required" | "suggested" | "unmapped" =
        l.mapping_status === "resolved"
          ? "confirmed"
          : l.mapping_status === "review_required"
            ? "review_required"
            : candidates.length > 0
              ? "suggested"
              : "unmapped";

      return {
        lineId: l.id,
        recipeId: l.recipe_id,
        recipeCode: recipe?.code ?? null,
        recipeName: recipe?.name ?? null,
        recipeStatus: recipe?.status ?? null,
        servicePeriod: recipe?.service_period ?? null,
        sourceSection: recipe?.source_section ?? null,
        ingredientName: l.ingredient_name,
        ingredientKey: key,
        quantityMin: l.quantity_min,
        quantityMax: l.quantity_max,
        sourceUnit: l.source_unit,
        candidateSku: l.candidate_sku,
        mappingStatus: l.mapping_status,
        state,
        sourceFile: l.source_file,
        sourceRow: l.source_row,
        mappedItem: mapped
          ? {
              inventoryItemId: mapped.id,
              sku: mapped.sku,
              name: mapped.name,
              stockUnit: mapped.unit_id ? (ref.unitById.get(mapped.unit_id)?.code ?? null) : null,
            }
          : null,
        suggestion: alias
          ? {
              inventoryItemId: alias.inventory_item_id,
              sku: itemById.get(alias.inventory_item_id)?.sku ?? null,
              name: itemById.get(alias.inventory_item_id)?.name ?? null,
              confirmedFor: alias.ingredient_name,
              note: alias.note ?? null,
            }
          : null,
        candidates,
      };
    });

  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.ingredientKey, (byKey.get(r.ingredientKey) ?? 0) + 1);
  const withSiblings = rows.map((r) => ({ ...r, occurrences: byKey.get(r.ingredientKey) ?? 1 }));

  const counts = {
    total: withSiblings.length,
    unmapped: withSiblings.filter((r) => r.state === "unmapped").length,
    suggested: withSiblings.filter((r) => r.state === "suggested").length,
    confirmed: withSiblings.filter((r) => r.state === "confirmed").length,
    reviewRequired: withSiblings.filter((r) => r.state === "review_required").length,
  };

  const filtered =
    !input.state || input.state === "all"
      ? withSiblings
      : withSiblings.filter((r) =>
          input.state === "review_required"
            ? r.state === "review_required"
            : r.state === input.state,
        );

  return {
    rows: filtered.slice(0, input.limit ?? 400),
    counts,
    recipes: recipes.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      servicePeriod: r.service_period,
    })),
    catalogSize: ref.items.length,
  };
}

function emptyCounts() {
  return { total: 0, unmapped: 0, suggested: 0, confirmed: 0, reviewRequired: 0 };
}

export interface DecideMappingInput {
  tenantId: string;
  lineId: string;
  decision: MappingDecision;
  inventoryItemId?: string | null;
  note?: string | null;
  /** Deliberate opt-in: also apply this confirmation to identical ingredient text elsewhere. */
  applyToMatchingLines?: boolean;
  /**
   * Accept a mapping whose unit compatibility cannot be established because a
   * unit is missing from the source or the catalog. The mapping is kept, but
   * the line stays in review so the recipe cannot be costed or activated on an
   * unverified conversion.
   */
  acknowledgeUnknownUnit?: boolean;
}

/**
 * Record one administrator decision about one ingredient line.
 * Confirmation requires a catalog item that already exists and whose stock unit
 * can express the recipe's unit — otherwise the mapping would silently invent a
 * conversion.
 */
export async function decideIngredientMapping(sb: Sb, userId: string, input: DecideMappingInput) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");

  const { data: line } = await sb
    .from("restaurant_recipe_lines")
    .select(LINE_SELECT)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.lineId)
    .single();
  if (!line) throw new Error("Recipe line not found.");

  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, code, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", line.recipe_id)
    .single();

  const key = ingredientKey(line.ingredient_name);
  const now = new Date().toISOString();
  const previous = {
    itemId: line.inventory_item_id ?? null,
    status: line.mapping_status as string,
  };

  let newStatus = line.mapping_status as string;
  let newItemId: string | null = line.inventory_item_id ?? null;
  let item: any = null;
  let unitVerified = false;
  const alsoApplied: string[] = [];

  if (input.decision === "confirmed" || input.decision === "rejected") {
    if (!input.inventoryItemId) throw new Error("A catalog item is required for this decision.");
    const { data: found } = await sb
      .from("restaurant_inventory_items")
      .select("id, sku, name, unit_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.inventoryItemId)
      .single();
    if (!found)
      throw new Error(
        "That item is not in this tenant's master catalog. Add it to the catalog first — recipes never create stock items.",
      );
    item = found;
  }

  if (input.decision === "confirmed") {
    const { data: units } = await sb
      .from("restaurant_inventory_units")
      .select("id, code, dimension")
      .in("id", [line.unit_id, item.unit_id].filter(Boolean));
    const unitById = new Map<string, any>(((units ?? []) as any[]).map((u) => [u.id, u]));
    const compat = unitCompatibility(unitById, line.unit_id, item.unit_id);
    if (compat === false) {
      throw new Error(
        `The recipe unit ("${line.source_unit ?? "not stated"}") measures something different from the stock unit of ${item.sku}. Resolve the unit before confirming this mapping.`,
      );
    }
    if (compat === null && !input.acknowledgeUnknownUnit) {
      throw new Error(
        `Unit compatibility cannot be established for ${item.sku} — the recipe unit ("${line.source_unit ?? "not stated"}") or the catalog stock unit is missing. Complete the unit, or confirm explicitly and the line will stay in review.`,
      );
    }
    unitVerified = compat === true;
    newItemId = item.id;
    // An unverified unit means an unknown conversion, so the line stays in
    // review: mapped for provenance, but never counted as costable.
    newStatus = compat === true ? "resolved" : "review_required";
  } else if (input.decision === "rejected") {
    if (line.inventory_item_id === item.id) newItemId = null;
    newStatus = newItemId ? line.mapping_status : "unresolved";
  } else if (input.decision === "left_unresolved") {
    newItemId = null;
    newStatus = "unresolved";
  } else {
    newItemId = line.inventory_item_id ?? null;
    newStatus = "review_required";
  }

  const { error: lineErr } = await sb
    .from("restaurant_recipe_lines")
    .update({ inventory_item_id: newItemId, mapping_status: newStatus, updated_at: now })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.lineId);
  if (lineErr) throw new Error(lineErr.message);

  /* -------- the reusable mapping library -------- */
  if (input.decision === "confirmed" || input.decision === "rejected") {
    const { error: aliasErr } = await sb.from("restaurant_recipe_ingredient_aliases").upsert(
      {
        tenant_id: input.tenantId,
        ingredient_key: key,
        ingredient_name: line.ingredient_name ?? key,
        inventory_item_id: item.id,
        status: input.decision === "confirmed" ? "confirmed" : "rejected",
        evidence: { unit_verified: input.decision === "confirmed" ? unitVerified : null },
        note: input.note ?? null,
        updated_by: userId,
        created_by: userId,
        updated_at: now,
      },
      { onConflict: "tenant_id,ingredient_key,inventory_item_id" },
    );
    if (aliasErr) throw new Error(aliasErr.message);
  }

  /* -------- optional, explicit fan-out to identical ingredient text -------- */
  if (input.decision === "confirmed" && input.applyToMatchingLines && unitVerified) {
    const { data: siblings } = await sb
      .from("restaurant_recipe_lines")
      .select(
        "id, recipe_id, ingredient_name, unit_id, mapping_status, inventory_item_id, candidate_sku, source_unit",
      )
      .eq("tenant_id", input.tenantId)
      .neq("id", input.lineId)
      .neq("mapping_status", "resolved");
    for (const s of (siblings ?? []) as any[]) {
      if (ingredientKey(s.ingredient_name) !== key) continue;
      if (s.unit_id !== line.unit_id) continue; // same unit only; anything else needs its own judgement
      await sb
        .from("restaurant_recipe_lines")
        .update({ inventory_item_id: item.id, mapping_status: "resolved", updated_at: now })
        .eq("tenant_id", input.tenantId)
        .eq("id", s.id);
      alsoApplied.push(s.id);
      await sb.from("restaurant_recipe_mapping_decisions").insert({
        tenant_id: input.tenantId,
        recipe_id: s.recipe_id,
        recipe_line_id: s.id,
        ingredient_key: key,
        ingredient_name: s.ingredient_name,
        decision: "confirmed",
        inventory_item_id: item.id,
        previous_inventory_item_id: s.inventory_item_id ?? null,
        previous_mapping_status: s.mapping_status,
        new_mapping_status: "resolved",
        candidate_sku: s.candidate_sku ?? null,
        evidence: {
          applied_from_line: input.lineId,
          reason: "Identical ingredient text and unit, confirmed in bulk by an administrator.",
        },
        note: input.note ?? null,
        applied_to_all: true,
        decided_by: userId,
      });
    }
  }

  const { error: auditErr } = await sb.from("restaurant_recipe_mapping_decisions").insert({
    tenant_id: input.tenantId,
    recipe_id: line.recipe_id,
    recipe_line_id: line.id,
    recipe_code: recipe?.code ?? null,
    ingredient_key: key,
    ingredient_name: line.ingredient_name,
    decision: input.decision,
    inventory_item_id: item?.id ?? null,
    previous_inventory_item_id: previous.itemId,
    previous_mapping_status: previous.status,
    new_mapping_status: newStatus,
    candidate_sku: line.candidate_sku ?? null,
    evidence: {
      source_file: line.source_file ?? null,
      source_row: line.source_row ?? null,
      source_unit: line.source_unit ?? null,
    },
    note: input.note ?? null,
    applied_to_all: alsoApplied.length > 0,
    decided_by: userId,
  });
  if (auditErr) throw new Error(auditErr.message);

  return {
    lineId: line.id,
    mappingStatus: newStatus,
    inventoryItemId: newItemId,
    alsoApplied: alsoApplied.length,
  };
}

/** Full decision history — for one line, one ingredient, or the whole tenant. */
export async function listMappingDecisions(
  sb: Sb,
  userId: string,
  input: { tenantId: string; lineId?: string; ingredientKey?: string; limit?: number },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_recipe_mapping_decisions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 200);
  if (input.lineId) q = q.eq("recipe_line_id", input.lineId);
  if (input.ingredientKey) q = q.eq("ingredient_key", input.ingredientKey);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The reusable library of confirmed and rejected ingredient mappings. */
export async function listIngredientAliases(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_ingredient_aliases")
    .select("id, ingredient_key, ingredient_name, inventory_item_id, status, note, updated_at")
    .eq("tenant_id", tenantId)
    .order("ingredient_key");
  if (error) throw new Error(error.message);
  return data ?? [];
}
