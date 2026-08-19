/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Product / recipe / production *evidence* for the existing Restaurant
 * Intelligence layer.
 *
 * This file states facts. It draws no conclusions, ranks nothing and contains
 * no reasoning: the Intelligence Core owns all of that. Adding an algorithm
 * here would create a second brain, which the architecture forbids.
 */
import { assertTenantRead } from "../core/access.server";

type Sb = any;

const DAY = 86_400_000;

export async function getProductEvidence(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const now = Date.now();

  const [{ data: products }, { data: recipes }, { data: history }, { data: productions }, { data: soldLines }] =
    await Promise.all([
      sb
        .from("restaurant_products")
        .select("id, sku, name, price, currency, recipe_id, active, product_type")
        .eq("tenant_id", tenantId),
      sb
        .from("restaurant_recipes")
        .select("id, code, name, version, status, computed_cost, target_cost, last_reviewed_at, updated_at, currency")
        .eq("tenant_id", tenantId),
      sb
        .from("restaurant_recipe_cost_history")
        .select("recipe_id, total_cost, computed_at")
        .eq("tenant_id", tenantId)
        .order("computed_at", { ascending: false })
        .limit(600),
      sb
        .from("restaurant_productions")
        .select("id, production_number, recipe_id, status, planned_quantity, actual_quantity, yield_variance_percent, input_cost, completed_at")
        .eq("tenant_id", tenantId)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(200),
      sb
        .from("restaurant_order_items")
        .select("recipe_id, quantity, line_total, theoretical_cost, line_cost, status")
        .eq("tenant_id", tenantId)
        .not("recipe_id", "is", null)
        .limit(2000),
    ]);

  const recipeRows = (recipes ?? []) as any[];
  const recipeById = new Map(recipeRows.map((r) => [r.id, r]));

  /* Cost drift: earliest vs latest recorded cost per recipe. */
  const byRecipe = new Map<string, any[]>();
  for (const row of ((history ?? []) as any[])) {
    const list = byRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    byRecipe.set(row.recipe_id, list);
  }
  const costDrift = [...byRecipe.entries()]
    .map(([recipeId, rows]) => {
      const latest = Number(rows[0]?.total_cost ?? 0);
      const earliest = Number(rows[rows.length - 1]?.total_cost ?? 0);
      const recipe = recipeById.get(recipeId);
      return {
        recipe_id: recipeId,
        code: recipe?.code ?? null,
        name: recipe?.name ?? null,
        earliest_cost: earliest,
        latest_cost: latest,
        drift: Number((latest - earliest).toFixed(4)),
        drift_percent: earliest > 0 ? Number((((latest - earliest) / earliest) * 100).toFixed(2)) : null,
        samples: rows.length,
      };
    })
    .filter((r) => r.samples > 1);

  /* Recipe age — how long since anyone reviewed it. */
  const recipeAge = recipeRows
    .filter((r) => r.status === "active")
    .map((r) => {
      const stamp = r.last_reviewed_at ?? r.updated_at;
      return {
        recipe_id: r.id,
        code: r.code,
        name: r.name,
        version: r.version,
        last_reviewed_at: stamp,
        days_since_review: stamp ? Math.floor((now - new Date(stamp).getTime()) / DAY) : null,
      };
    });

  /* Products sold with no recipe behind them (retail lines excluded). */
  const missingRecipes = ((products ?? []) as any[])
    .filter((p) => p.active && !p.recipe_id && p.product_type !== "retail" && p.product_type !== "bundle")
    .map((p) => ({ product_id: p.id, sku: p.sku, name: p.name, price: Number(p.price ?? 0) }));

  /* Production yield variance, as recorded — cause not inferred. */
  const yieldVariance = ((productions ?? []) as any[]).map((p) => ({
    production_id: p.id,
    production_number: p.production_number,
    recipe_id: p.recipe_id,
    code: recipeById.get(p.recipe_id)?.code ?? null,
    planned_quantity: Number(p.planned_quantity ?? 0),
    actual_quantity: Number(p.actual_quantity ?? 0),
    variance_percent: p.yield_variance_percent == null ? null : Number(p.yield_variance_percent),
    completed_at: p.completed_at,
  }));

  /* Theoretical vs actual consumption cost per recipe, from sold lines. */
  const consumption = new Map<string, { theoretical: number; actual: number; revenue: number; units: number }>();
  for (const line of ((soldLines ?? []) as any[])) {
    if (line.status === "voided") continue;
    const bucket = consumption.get(line.recipe_id) ?? { theoretical: 0, actual: 0, revenue: 0, units: 0 };
    bucket.theoretical += Number(line.theoretical_cost ?? 0);
    bucket.actual += Number(line.line_cost ?? 0);
    bucket.revenue += Number(line.line_total ?? 0);
    bucket.units += Number(line.quantity ?? 0);
    consumption.set(line.recipe_id, bucket);
  }
  const theoreticalVsActual = [...consumption.entries()].map(([recipeId, b]) => ({
    recipe_id: recipeId,
    code: recipeById.get(recipeId)?.code ?? null,
    units_sold: Number(b.units.toFixed(3)),
    revenue: Number(b.revenue.toFixed(2)),
    theoretical_cost: Number(b.theoretical.toFixed(4)),
    actual_cost: Number(b.actual.toFixed(4)),
    variance: Number((b.actual - b.theoretical).toFixed(4)),
  }));

  /* Product margin at current recipe cost. */
  const productMargin = ((products ?? []) as any[])
    .filter((p) => p.recipe_id)
    .map((p) => {
      const cost = Number(recipeById.get(p.recipe_id)?.computed_cost ?? 0);
      const price = Number(p.price ?? 0);
      return {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        price,
        cost,
        gross_profit: Number((price - cost).toFixed(2)),
        margin_percent: price > 0 ? Number((((price - cost) / price) * 100).toFixed(1)) : null,
      };
    });

  return {
    generated_at: new Date().toISOString(),
    counts: {
      products: (products ?? []).length,
      recipes: recipeRows.length,
      active_recipes: recipeRows.filter((r) => r.status === "active").length,
      completed_productions: yieldVariance.length,
    },
    cost_drift: costDrift,
    recipe_age: recipeAge,
    missing_recipes: missingRecipes,
    yield_variance: yieldVariance,
    theoretical_vs_actual: theoreticalVsActual,
    product_margin: productMargin,
  };
}
