/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * F&B catalog enrichment — gap analysis and the controlled ways to close a gap.
 *
 * Non-negotiables enforced here:
 *   • nothing is created because a recipe merely mentions it: every new master
 *     catalog item passes REVIEW → APPROVE → CREATE, by a person
 *   • no stock unit is guessed into place; a suggestion is evidence, not a fact
 *   • no balances, movements, prices, menu items or activations are touched
 *   • a recipe is only COSTABLE when every line is verified and costed;
 *     anything else is reported as PARTIAL or NON_COSTABLE, never rounded up
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { ingredientKey, scoreCandidate } from "./mapping";
import {
  catalogPrefix,
  classifyLine,
  costingState,
  nextSku,
  suggestStockUnit,
  suggestUnitForMissingItem,
  type CostingState,
  type GapClass,
} from "./gap-analysis";

type Sb = any;

function emptyClassCounts(): Record<GapClass, number> {
  return {
    VERIFIED_MATCH: 0,
    MATCH_REQUIRES_REVIEW: 0,
    MISSING_CATALOG_ITEM: 0,
    UNIT_MISMATCH: 0,
    MISSING_STOCK_UNIT: 0,
    AMBIGUOUS: 0,
  };
}

async function loadWorld(sb: Sb, tenantId: string) {
  const [items, units, categories, recipes, lines, requests] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select(
        "id, sku, name, domain, subcategory, category_id, unit_id, purchase_unit_id, pack_label, pack_size, average_cost, data_status, status",
      )
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_inventory_units")
      .select("id, code, name, dimension")
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`),
    sb.from("restaurant_inventory_categories").select("id, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_recipes")
      .select("id, code, name, status, service_period, source_section, source_file")
      .eq("tenant_id", tenantId)
      .not("source_recipe_code", "is", null),
    sb
      .from("restaurant_recipe_lines")
      .select(
        "id, recipe_id, ingredient_name, quantity, quantity_min, quantity_max, source_unit, unit_id, candidate_sku, inventory_item_id, mapping_status, source_file, source_row",
      )
      .eq("tenant_id", tenantId),
    sb.from("restaurant_catalog_item_requests").select("*").eq("tenant_id", tenantId),
  ]);

  for (const r of [items, units, categories, recipes, lines, requests]) {
    if (r.error) throw new Error(r.error.message);
  }

  const unitById = new Map<string, any>(((units.data ?? []) as any[]).map((u) => [u.id, u]));
  const unitByCode = new Map<string, any>();
  for (const u of (units.data ?? []) as any[]) {
    if (!unitByCode.has(u.code)) unitByCode.set(u.code, u);
  }
  return {
    items: (items.data ?? []) as any[],
    unitById,
    unitByCode,
    categories: (categories.data ?? []) as any[],
    recipes: (recipes.data ?? []) as any[],
    lines: (lines.data ?? []) as any[],
    requests: (requests.data ?? []) as any[],
  };
}

function analyse(world: Awaited<ReturnType<typeof loadWorld>>) {
  const itemById = new Map<string, any>(world.items.map((i) => [i.id, i]));
  const categoryById = new Map<string, any>(world.categories.map((c) => [c.id, c]));
  const recipeById = new Map<string, any>(world.recipes.map((r) => [r.id, r]));

  const analysed = world.lines
    .filter((l) => recipeById.has(l.recipe_id))
    .map((l) => {
      const lineUnit = l.unit_id ? world.unitById.get(l.unit_id) : null;
      const mappedItem = l.inventory_item_id ? itemById.get(l.inventory_item_id) : null;
      const mappedUnit = mappedItem?.unit_id ? world.unitById.get(mappedItem.unit_id) : null;

      const scores = mappedItem
        ? []
        : world.items
            .map((item) =>
              scoreCandidate({
                ingredientName: l.ingredient_name,
                candidateSku: l.candidate_sku,
                item: {
                  sku: item.sku,
                  name: item.name,
                  subcategory: item.subcategory,
                  categoryName: item.category_id
                    ? (categoryById.get(item.category_id)?.name ?? null)
                    : null,
                },
              }).score,
            )
            .sort((a, b) => b - a)
            .slice(0, 5);

      const verdict = classifyLine({
        mappingStatus: l.mapping_status,
        mapped: mappedItem
          ? {
              hasStockUnit: Boolean(mappedItem.unit_id),
              stockUnitDimension: mappedUnit?.dimension ?? null,
              hasCostBasis: Number(mappedItem.average_cost ?? 0) > 0,
            }
          : null,
        lineUnitDimension: lineUnit?.dimension ?? null,
        lineUnitStated: Boolean(l.source_unit),
        candidateScores: scores,
      });

      return {
        line: l,
        recipe: recipeById.get(l.recipe_id),
        key: ingredientKey(l.ingredient_name),
        lineUnitCode: lineUnit?.code ?? null,
        mappedItem,
        topScore: scores[0] ?? 0,
        ...verdict,
      };
    });

  return { analysed, itemById, categoryById, recipeById };
}

export interface GapAnalysisReport {
  recipeCount: number;
  lineCount: number;
  counts: Record<GapClass, number>;
  costing: { costable: number; partial: number; nonCostable: number };
  recipes: {
    id: string;
    code: string | null;
    name: string;
    status: string;
    servicePeriod: string | null;
    lineCount: number;
    counts: Record<GapClass, number>;
    costingState: CostingState;
  }[];
  topMissingIngredients: { ingredientKey: string; ingredientName: string; occurrences: number; recipes: number }[];
  catalogSize: number;
  catalogWithoutStockUnit: number;
}

/** The whole picture: every imported ingredient line, classified. */
export async function getRecipeGapAnalysis(
  sb: Sb,
  userId: string,
  input: { tenantId: string },
): Promise<GapAnalysisReport> {
  await assertTenantRead(sb, userId, input.tenantId);
  const world = await loadWorld(sb, input.tenantId);
  const { analysed } = analyse(world);

  const counts = emptyClassCounts();
  for (const a of analysed) counts[a.classification] += 1;

  const byRecipe = new Map<string, typeof analysed>();
  for (const a of analysed) {
    const list = byRecipe.get(a.line.recipe_id) ?? [];
    list.push(a);
    byRecipe.set(a.line.recipe_id, list);
  }

  const recipes = world.recipes.map((r) => {
    const list = byRecipe.get(r.id) ?? [];
    const rc = emptyClassCounts();
    for (const a of list) rc[a.classification] += 1;
    return {
      id: r.id,
      code: r.code ?? null,
      name: r.name,
      status: r.status,
      servicePeriod: r.service_period ?? null,
      lineCount: list.length,
      counts: rc,
      costingState: costingState(list.map((a) => a.costable)),
    };
  });

  const missing = new Map<string, { ingredientName: string; occurrences: number; recipes: Set<string> }>();
  for (const a of analysed) {
    if (a.classification !== "MISSING_CATALOG_ITEM") continue;
    const entry = missing.get(a.key) ?? {
      ingredientName: a.line.ingredient_name ?? a.key,
      occurrences: 0,
      recipes: new Set<string>(),
    };
    entry.occurrences += 1;
    entry.recipes.add(a.line.recipe_id);
    missing.set(a.key, entry);
  }

  return {
    recipeCount: world.recipes.length,
    lineCount: analysed.length,
    counts,
    costing: {
      costable: recipes.filter((r) => r.costingState === "COSTABLE").length,
      partial: recipes.filter((r) => r.costingState === "PARTIAL").length,
      nonCostable: recipes.filter((r) => r.costingState === "NON_COSTABLE").length,
    },
    recipes: recipes.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
    topMissingIngredients: Array.from(missing.entries())
      .map(([key, v]) => ({
        ingredientKey: key,
        ingredientName: v.ingredientName,
        occurrences: v.occurrences,
        recipes: v.recipes.size,
      }))
      .sort((a, b) => b.occurrences - a.occurrences || a.ingredientName.localeCompare(b.ingredientName)),
    catalogSize: world.items.length,
    catalogWithoutStockUnit: world.items.filter((i) => !i.unit_id).length,
  };
}

/* ---------------- Missing master catalog items ---------------- */

/**
 * The review queue of ingredients the catalog does not contain. Derived from
 * the evidence on every request, then overlaid with any decision already taken.
 */
export async function listMissingCatalogItems(sb: Sb, userId: string, input: { tenantId: string }) {
  await assertTenantRead(sb, userId, input.tenantId);
  const world = await loadWorld(sb, input.tenantId);
  const { analysed, categoryById } = analyse(world);
  const requestByKey = new Map<string, any>(world.requests.map((r) => [r.ingredient_key, r]));

  const grouped = new Map<string, any>();
  for (const a of analysed) {
    if (a.classification !== "MISSING_CATALOG_ITEM") continue;
    const g = grouped.get(a.key) ?? {
      ingredientKey: a.key,
      ingredientName: a.line.ingredient_name ?? a.key,
      occurrences: 0,
      recipes: [] as any[],
      quantities: [] as string[],
      unitCodes: [] as string[],
      sources: [] as any[],
    };
    g.occurrences += 1;
    if (!g.recipes.some((r: any) => r.id === a.line.recipe_id)) {
      g.recipes.push({
        id: a.line.recipe_id,
        code: a.recipe?.code ?? null,
        name: a.recipe?.name ?? null,
        servicePeriod: a.recipe?.service_period ?? null,
      });
    }
    const qty = a.line.quantity_min ?? a.line.quantity_max ?? a.line.quantity;
    g.quantities.push(`${qty ?? "—"} ${a.line.source_unit ?? ""}`.trim());
    if (a.lineUnitCode) g.unitCodes.push(a.lineUnitCode);
    g.sources.push({
      recipeCode: a.recipe?.code ?? null,
      sourceFile: a.line.source_file ?? null,
      sourceRow: a.line.source_row ?? null,
      candidateSku: a.line.candidate_sku ?? null,
    });
    grouped.set(a.key, g);
  }

  // Suggested placement comes from the nearest catalog neighbours, so the
  // suggestion follows the catalog's own taxonomy rather than a fixed list.
  const rows = Array.from(grouped.values()).map((g) => {
    const neighbours = world.items
      .map((item) => ({
        item,
        score: scoreCandidate({
          ingredientName: g.ingredientName,
          candidateSku: null,
          item: {
            sku: item.sku,
            name: item.name,
            subcategory: item.subcategory,
            categoryName: item.category_id ? (categoryById.get(item.category_id)?.name ?? null) : null,
          },
        }).score,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((n) => n.score > 0);
    const best = neighbours[0]?.item ?? null;
    const unit = suggestUnitForMissingItem(g.unitCodes);
    const request = requestByKey.get(g.ingredientKey) ?? null;

    return {
      ...g,
      quantities: Array.from(new Set(g.quantities)).slice(0, 6),
      unitCodes: Array.from(new Set(g.unitCodes)),
      suggestedDomain: best?.domain ?? "FNB",
      suggestedCategory: best?.category_id ? (categoryById.get(best.category_id)?.name ?? null) : null,
      suggestedSubcategory: best?.subcategory ?? null,
      suggestedStockUnitCode: unit.stockUnitCode,
      suggestedStockUnitReason: unit.stockUnitReason,
      nearestCatalogItems: neighbours.map((n) => ({
        sku: n.item.sku,
        name: n.item.name,
        score: Number(n.score.toFixed(3)),
      })),
      request: request
        ? {
            id: request.id,
            status: request.status,
            note: request.note,
            createdSku: request.created_sku,
            reviewedAt: request.reviewed_at,
          }
        : null,
    };
  });

  rows.sort((a, b) => b.occurrences - a.occurrences || a.ingredientName.localeCompare(b.ingredientName));

  // Requests already created keep their history visible even though the
  // ingredient no longer classifies as missing.
  const derivedKeys = new Set(rows.map((r) => r.ingredientKey));
  const settled = world.requests
    .filter((r) => !derivedKeys.has(r.ingredient_key))
    .map((r) => ({
      ingredientKey: r.ingredient_key,
      ingredientName: r.ingredient_name,
      occurrences: r.occurrences,
      status: r.status,
      createdSku: r.created_sku,
      note: r.note,
      reviewedAt: r.reviewed_at,
    }));

  const units = Array.from(world.unitByCode.values()).map((u: any) => ({
    code: u.code,
    name: u.name,
    dimension: u.dimension,
  }));
  return {
    rows,
    settled,
    units,
    categories: world.categories.map((c) => ({ id: c.id, name: c.name })),
  };
}

export interface ReviewRequestInput {
  tenantId: string;
  ingredientKey: string;
  ingredientName: string;
  occurrences?: number;
  decision: "approve" | "reject";
  suggestedDomain?: string | null;
  suggestedCategory?: string | null;
  suggestedSubcategory?: string | null;
  suggestedStockUnitCode?: string | null;
  suggestedPurchaseUnitCode?: string | null;
  suggestedName?: string | null;
  provenance?: Record<string, unknown>;
  note?: string | null;
}

/** Step 1 and 2 of REVIEW → APPROVE → CREATE. Creates no catalog item. */
export async function reviewCatalogItemRequest(sb: Sb, userId: string, input: ReviewRequestInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const now = new Date().toISOString();
  const status = input.decision === "approve" ? "approved" : "rejected";

  const { data, error } = await sb
    .from("restaurant_catalog_item_requests")
    .upsert(
      {
        tenant_id: input.tenantId,
        ingredient_key: input.ingredientKey,
        ingredient_name: input.ingredientName,
        occurrences: input.occurrences ?? 1,
        suggested_domain: input.suggestedDomain ?? null,
        suggested_category: input.suggestedCategory ?? null,
        suggested_subcategory: input.suggestedSubcategory ?? null,
        suggested_stock_unit_code: input.suggestedStockUnitCode ?? null,
        suggested_purchase_unit_code: input.suggestedPurchaseUnitCode ?? null,
        suggested_name: input.suggestedName ?? null,
        provenance: (input.provenance ?? {}) as any,
        status,
        note: input.note ?? null,
        reviewed_by: userId,
        reviewed_at: now,
        created_by: userId,
        updated_at: now,
      },
      { onConflict: "tenant_id,ingredient_key" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const { error: auditErr } = await sb.from("restaurant_catalog_enrichment_decisions").insert({
    tenant_id: input.tenantId,
    decision: status === "approved" ? "item_approved" : "item_rejected",
    request_id: data.id,
    ingredient_key: input.ingredientKey,
    ingredient_name: input.ingredientName,
    new_value: { status },
    evidence: (input.provenance ?? {}) as any,
    note: input.note ?? null,
    decided_by: userId,
  });
  if (auditErr) throw new Error(auditErr.message);
  return data;
}

export interface CreateCatalogItemInput {
  tenantId: string;
  requestId: string;
  name: string;
  domain: string;
  categoryName?: string | null;
  subcategory?: string | null;
  skuCode: string;
  stockUnitCode?: string | null;
  purchaseUnitCode?: string | null;
  note?: string | null;
}

/**
 * Step 3: create the master catalog item an administrator has approved.
 * Identity and configuration only — never a balance, a movement or a price.
 */
export async function createCatalogItemFromRequest(
  sb: Sb,
  userId: string,
  input: CreateCatalogItemInput,
) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");

  const { data: request, error: reqErr } = await sb
    .from("restaurant_catalog_item_requests")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.requestId)
    .maybeSingle();
  if (reqErr) throw new Error(reqErr.message);
  if (!request) throw new Error("That catalog item request no longer exists.");
  if (request.status === "created")
    throw new Error(`Already created as ${request.created_sku ?? "a catalog item"}.`);
  if (request.status !== "approved")
    throw new Error("This request must be approved by a reviewer before the item can be created.");

  const world = await loadWorld(sb, input.tenantId);

  // Duplicate guard: never create a second identity for the same thing.
  const wanted = ingredientKey(input.name);
  const duplicate = world.items.find(
    (i) => ingredientKey(i.name) === wanted || ingredientKey(i.name) === request.ingredient_key,
  );
  if (duplicate)
    throw new Error(
      `The catalog already contains "${duplicate.name}" (${duplicate.sku}). Map the ingredient to it instead of creating a duplicate.`,
    );

  const domain = input.domain.trim().toUpperCase();
  const code = input.skuCode.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(code)) throw new Error("The SKU category code must be 2–4 letters.");
  const prefix = catalogPrefix(world.items.map((i) => i.sku));
  const sku = nextSku(world.items.map((i) => i.sku), prefix, domain, code);

  let categoryId: string | null = null;
  if (input.categoryName) {
    const existing = world.categories.find(
      (c) => c.name.toLowerCase() === input.categoryName!.trim().toLowerCase(),
    );
    if (existing) categoryId = existing.id;
    else {
      const { data: created, error } = await sb
        .from("restaurant_inventory_categories")
        .insert({
          tenant_id: input.tenantId,
          name: input.categoryName.trim(),
          slug: input.categoryName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          kind: "ingredient",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      categoryId = created.id;
    }
  }

  const stockUnit = input.stockUnitCode ? world.unitByCode.get(input.stockUnitCode) : null;
  if (input.stockUnitCode && !stockUnit)
    throw new Error(`Unknown stock unit "${input.stockUnitCode}".`);
  const purchaseUnit = input.purchaseUnitCode ? world.unitByCode.get(input.purchaseUnitCode) : null;
  if (input.purchaseUnitCode && !purchaseUnit)
    throw new Error(`Unknown purchase unit "${input.purchaseUnitCode}".`);

  const provenance = {
    origin: "recipe_gap_analysis",
    ingredient_key: request.ingredient_key,
    ingredient_name: request.ingredient_name,
    request_id: request.id,
    approved_by: request.reviewed_by,
    approved_at: request.reviewed_at,
    ...(request.provenance ?? {}),
  };

  const { data: item, error: itemErr } = await sb
    .from("restaurant_inventory_items")
    .insert({
      tenant_id: input.tenantId,
      sku,
      name: input.name.trim(),
      domain,
      subcategory: input.subcategory?.trim() || null,
      category_id: categoryId,
      unit_id: stockUnit?.id ?? null,
      purchase_unit_id: purchaseUnit?.id ?? null,
      item_type: "ingredient",
      status: "active",
      data_status: stockUnit ? "CONFIRMED" : "UNCONFIRMED",
      source: "RECIPE_GAP_REVIEW",
      pack_size: 1,
      current_quantity: 0,
      average_cost: 0,
    })
    .select("id, sku, name")
    .single();
  if (itemErr) throw new Error(itemErr.message);

  const { error: updErr } = await sb
    .from("restaurant_catalog_item_requests")
    .update({
      status: "created",
      created_item_id: item.id,
      created_sku: sku,
      note: input.note ?? request.note,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", request.id);
  if (updErr) throw new Error(updErr.message);

  const { error: auditErr } = await sb.from("restaurant_catalog_enrichment_decisions").insert({
    tenant_id: input.tenantId,
    decision: "item_created",
    request_id: request.id,
    inventory_item_id: item.id,
    sku,
    ingredient_key: request.ingredient_key,
    ingredient_name: request.ingredient_name,
    new_value: {
      sku,
      name: item.name,
      domain,
      category: input.categoryName ?? null,
      subcategory: input.subcategory ?? null,
      stock_unit: input.stockUnitCode ?? null,
      purchase_unit: input.purchaseUnitCode ?? null,
    },
    evidence: provenance,
    note: input.note ?? null,
    decided_by: userId,
  });
  if (auditErr) throw new Error(auditErr.message);

  return { itemId: item.id, sku, name: item.name };
}

/* ---------------- Stock unit completeness ---------------- */

/** Every catalog item with no stock unit, with the evidence for a suggestion. */
export async function listStockUnitGaps(sb: Sb, userId: string, input: { tenantId: string }) {
  await assertTenantRead(sb, userId, input.tenantId);
  const world = await loadWorld(sb, input.tenantId);
  const categoryById = new Map<string, any>(world.categories.map((c) => [c.id, c]));
  const recipeById = new Map<string, any>(world.recipes.map((r) => [r.id, r]));

  type Usage = { unitCodes: string[]; recipes: Map<string, string> };
  const usageByItem = new Map<string, Usage>();
  for (const l of world.lines) {
    if (!l.inventory_item_id) continue;
    const entry: Usage = usageByItem.get(l.inventory_item_id) ?? {
      unitCodes: [],
      recipes: new Map<string, string>(),
    };
    const code = l.unit_id ? world.unitById.get(l.unit_id)?.code : null;
    if (code) entry.unitCodes.push(code);
    const recipe = recipeById.get(l.recipe_id);
    if (recipe) entry.recipes.set(recipe.id, recipe.code ?? recipe.name);
    usageByItem.set(l.inventory_item_id, entry);
  }

  const rows = world.items
    .filter((i) => !i.unit_id)
    .map((i) => {
      const usage = usageByItem.get(i.id) ?? { unitCodes: [], recipes: new Map<string, string>() };
      const purchaseUnit = i.purchase_unit_id ? world.unitById.get(i.purchase_unit_id) : null;
      const suggestion = suggestStockUnit({
        purchaseUnitCode: purchaseUnit?.code ?? null,
        packLabel: i.pack_label ?? null,
        itemName: i.name ?? null,
        recipeUnitCodes: usage.unitCodes,
      });
      return {
        itemId: i.id,
        sku: i.sku,
        name: i.name,
        domain: i.domain ?? null,
        categoryName: i.category_id ? (categoryById.get(i.category_id)?.name ?? null) : null,
        subcategory: i.subcategory ?? null,
        purchaseUnit: purchaseUnit?.code ?? null,
        packLabel: i.pack_label ?? null,
        currentStockUnit: null,
        affectedRecipes: Array.from(usage.recipes.values()),
        recipeUnitCodes: Array.from(new Set(usage.unitCodes)),
        suggestedStockUnit: suggestion.code,
        reason: suggestion.reason,
        state: suggestion.code ? "SUGGESTED" : "UNRESOLVED",
      };
    })
    .sort((a, b) => b.affectedRecipes.length - a.affectedRecipes.length || a.sku.localeCompare(b.sku));

  return {
    rows,
    units: Array.from(world.unitByCode.values()).map((u: any) => ({
      code: u.code,
      name: u.name,
      dimension: u.dimension,
    })),
    catalogSize: world.items.length,
  };
}

/** Confirm a stock unit for one catalog item. Never overwrites a known unit. */
export async function setCatalogStockUnit(
  sb: Sb,
  userId: string,
  input: { tenantId: string; itemId: string; unitCode: string; note?: string | null },
) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");

  const { data: item, error } = await sb
    .from("restaurant_inventory_items")
    .select("id, sku, name, unit_id, data_status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) throw new Error("That catalog item does not exist in this tenant.");
  if (item.unit_id)
    throw new Error(
      `${item.sku} already has a stock unit. Changing an established stock unit would restate existing quantities, so it is not done here.`,
    );

  const { data: unit, error: unitErr } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, name, dimension")
    .or(`tenant_id.is.null,tenant_id.eq.${input.tenantId}`)
    .eq("code", input.unitCode)
    .limit(1)
    .maybeSingle();
  if (unitErr) throw new Error(unitErr.message);
  if (!unit) throw new Error(`Unknown unit "${input.unitCode}".`);

  const { error: updErr } = await sb
    .from("restaurant_inventory_items")
    .update({ unit_id: unit.id, updated_at: new Date().toISOString() })
    .eq("tenant_id", input.tenantId)
    .eq("id", item.id);
  if (updErr) throw new Error(updErr.message);

  const { error: auditErr } = await sb.from("restaurant_catalog_enrichment_decisions").insert({
    tenant_id: input.tenantId,
    decision: "stock_unit_set",
    inventory_item_id: item.id,
    sku: item.sku,
    previous_value: { unit_id: null },
    new_value: { unit_code: unit.code, dimension: unit.dimension },
    evidence: { confirmed_from: "stock_unit_completeness_review" },
    note: input.note ?? null,
    decided_by: userId,
  });
  if (auditErr) throw new Error(auditErr.message);

  return { itemId: item.id, sku: item.sku, unitCode: unit.code };
}

/** Record that no reliable stock unit could be established. Changes no data. */
export async function markStockUnitUnresolved(
  sb: Sb,
  userId: string,
  input: { tenantId: string; itemId: string; note?: string | null },
) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const { data: item } = await sb
    .from("restaurant_inventory_items")
    .select("id, sku")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.itemId)
    .maybeSingle();
  if (!item) throw new Error("That catalog item does not exist in this tenant.");

  const { error } = await sb.from("restaurant_catalog_enrichment_decisions").insert({
    tenant_id: input.tenantId,
    decision: "stock_unit_unresolved",
    inventory_item_id: item.id,
    sku: item.sku,
    evidence: { confirmed_from: "stock_unit_completeness_review" },
    note: input.note ?? null,
    decided_by: userId,
  });
  if (error) throw new Error(error.message);
  return { itemId: item.id, sku: item.sku };
}

/** The enrichment audit trail. */
export async function listEnrichmentDecisions(
  sb: Sb,
  userId: string,
  input: { tenantId: string; limit?: number },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_catalog_enrichment_decisions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 200);
  if (error) throw new Error(error.message);
  return data ?? [];
}