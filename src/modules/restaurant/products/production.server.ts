/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Production — ingredients in, finished stock out.
 *
 * Production never touches a balance directly. Inputs post as `consumption`
 * movements and the output posts as a `production` movement, so the existing
 * ledger trigger remains the only thing that moves stock. Theoretical yield
 * comes from the recipe; actual yield comes from the person who weighed it.
 * The difference is recorded as evidence — the cause is not assumed.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "../inventory/movements.server";
import type {
  cancelProductionSchema,
  completeProductionSchema,
  listProductionsSchema,
  startProductionSchema,
} from "./contracts";
import { resolveRecipeCost } from "./recipe-cost.server";

type Sb = any;

function productionNumber() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `PRD-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export async function listProductions(sb: Sb, userId: string, input: z.infer<typeof listProductionsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_productions")
    .select(
      "id, production_number, recipe_id, recipe_version, status, production_location_id, output_location_id, output_inventory_item_id, batches, planned_quantity, actual_quantity, yield_variance_quantity, yield_variance_percent, input_cost, unit_cost, currency, started_at, completed_at, notes, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.status) q = q.eq("status", input.status);
  if (input.locationId) q = q.eq("production_location_id", input.locationId);
  if (input.from) q = q.gte("created_at", input.from);
  if (input.to) q = q.lte("created_at", input.to);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getProduction(sb: Sb, userId: string, tenantId: string, productionId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const [{ data: production, error }, { data: inputs }] = await Promise.all([
    sb.from("restaurant_productions").select("*").eq("tenant_id", tenantId).eq("id", productionId).single(),
    sb
      .from("restaurant_production_inputs")
      .select("id, inventory_item_id, unit_id, planned_quantity, actual_quantity, unit_cost, total_cost, movement_id, notes")
      .eq("tenant_id", tenantId)
      .eq("production_id", productionId),
  ]);
  if (error || !production) throw new Error("Production run not found.");

  const ids = ((inputs ?? []) as any[]).map((i) => i.inventory_item_id);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: items } = await sb.from("restaurant_inventory_items").select("id, name").in("id", ids);
    for (const it of ((items ?? []) as any[])) names.set(it.id, it.name);
  }
  return {
    production,
    inputs: ((inputs ?? []) as any[]).map((i) => ({ ...i, name: names.get(i.inventory_item_id) ?? "Item" })),
  };
}

/**
 * Starts a run: the recipe is exploded into planned inputs at today's cost and
 * pinned to a version. Nothing is consumed until the run is completed.
 */
export async function startProduction(sb: Sb, userId: string, input: z.infer<typeof startProductionSchema>) {
  await assertCapability(sb, userId, input.tenantId, "production.manage");

  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, code, name, version, status, yield_quantity, currency, produces_inventory_item_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.recipeId)
    .single();
  if (!recipe) throw new Error("Recipe not found.");
  if (recipe.status === "archived") throw new Error("Archived recipes cannot be produced.");
  if (!recipe.produces_inventory_item_id) {
    throw new Error("This recipe does not declare a produced stock item, so production has nowhere to land.");
  }

  const cost = await resolveRecipeCost(sb, input.tenantId, recipe.id);
  const batches = Number(input.batches);
  const planned = Number(recipe.yield_quantity ?? 1) * batches;

  const { data: production, error } = await sb
    .from("restaurant_productions")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      production_number: productionNumber(),
      recipe_id: recipe.id,
      recipe_version: recipe.version,
      status: "in_progress",
      production_location_id: input.productionLocationId ?? input.locationId ?? null,
      output_location_id: input.outputLocationId ?? input.productionLocationId ?? input.locationId ?? null,
      output_inventory_item_id: recipe.produces_inventory_item_id,
      batches,
      planned_quantity: Number(planned.toFixed(4)),
      input_cost: Number((cost.totalCost * batches).toFixed(4)),
      currency: recipe.currency ?? "TZS",
      started_at: new Date().toISOString(),
      started_by: userId,
      notes: input.notes ?? null,
      created_by: userId,
    })
    .select("id, production_number, planned_quantity")
    .single();
  if (error) throw new Error(error.message);

  const inputRows = cost.lines
    .filter((l) => l.kind === "inventory_item" && l.refId)
    .map((l) => ({
      tenant_id: input.tenantId,
      production_id: production.id,
      inventory_item_id: l.refId as string,
      planned_quantity: Number((l.effectiveQuantity * batches).toFixed(4)),
      actual_quantity: Number((l.effectiveQuantity * batches).toFixed(4)),
      unit_cost: l.unitCost,
      total_cost: Number((l.lineCost * batches).toFixed(4)),
    }));
  if (inputRows.length > 0) {
    const { error: inErr } = await sb.from("restaurant_production_inputs").insert(inputRows);
    if (inErr) throw new Error(inErr.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.production.started",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.productionLocationId ?? input.locationId ?? undefined,
    entityType: "restaurant_production",
    entityId: production.id,
    source: "restaurant-os",
    payload: {
      production_number: production.production_number,
      recipe: recipe.code,
      recipe_version: recipe.version,
      planned_quantity: Number(production.planned_quantity),
      batches,
    },
    dedupeKey: `production-started:${production.id}`,
  });
  return production;
}

/** Completes a run: consume inputs, create output, record yield variance. */
export async function completeProduction(sb: Sb, userId: string, input: z.infer<typeof completeProductionSchema>) {
  await assertCapability(sb, userId, input.tenantId, "production.manage");

  const { data: production } = await sb
    .from("restaurant_productions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.productionId)
    .single();
  if (!production) throw new Error("Production run not found.");
  if (production.status !== "in_progress") {
    throw new Error(`Production ${production.production_number} is ${production.status} and cannot be completed.`);
  }

  const { data: inputRows } = await sb
    .from("restaurant_production_inputs")
    .select("id, inventory_item_id, unit_id, planned_quantity, actual_quantity, unit_cost")
    .eq("tenant_id", input.tenantId)
    .eq("production_id", production.id);

  const overrides = new Map(input.inputs.map((i) => [i.inputId, i.actualQuantity]));
  const stamp = new Date().toISOString();
  let inputCost = 0;

  for (const row of ((inputRows ?? []) as any[])) {
    const quantity = Number(overrides.get(row.id) ?? row.actual_quantity ?? row.planned_quantity ?? 0);
    if (quantity <= 0) continue;
    const unitCost = Number(row.unit_cost ?? 0);
    const movement = await insertMovement(sb, userId, {
      tenantId: input.tenantId,
      propertyId: production.property_id,
      locationId: production.production_location_id,
      inventoryItemId: row.inventory_item_id,
      unitId: row.unit_id,
      movementType: "consumption",
      quantity: -Math.abs(quantity),
      unitCost,
      currency: production.currency ?? "TZS",
      reason: "Production input",
      referenceType: "restaurant_production",
      referenceId: production.id,
      productionId: production.id,
      occurredAt: stamp,
      dedupeKey: `production-input:${row.id}`,
    });
    inputCost += quantity * unitCost;
    await sb
      .from("restaurant_production_inputs")
      .update({
        actual_quantity: quantity,
        total_cost: Number((quantity * unitCost).toFixed(4)),
        movement_id: movement?.id ?? null,
      })
      .eq("id", row.id)
      .eq("tenant_id", input.tenantId);
  }

  const actual = Number(input.actualQuantity);
  const unitCost = actual > 0 ? Number((inputCost / actual).toFixed(4)) : 0;

  let outputMovementId: string | null = null;
  if (production.output_inventory_item_id && actual > 0) {
    const movement = await insertMovement(sb, userId, {
      tenantId: input.tenantId,
      propertyId: production.property_id,
      locationId: production.output_location_id ?? production.production_location_id,
      inventoryItemId: production.output_inventory_item_id,
      movementType: "production",
      quantity: Math.abs(actual),
      unitCost,
      currency: production.currency ?? "TZS",
      reason: "Production output",
      referenceType: "restaurant_production",
      referenceId: production.id,
      productionId: production.id,
      occurredAt: stamp,
      dedupeKey: `production-output:${production.id}`,
    });
    outputMovementId = movement?.id ?? null;
  }

  const planned = Number(production.planned_quantity ?? 0);
  const varianceQty = Number((actual - planned).toFixed(4));
  const variancePercent = planned > 0 ? Number(((varianceQty / planned) * 100).toFixed(2)) : null;

  const { data: updated, error } = await sb
    .from("restaurant_productions")
    .update({
      status: "completed",
      actual_quantity: actual,
      yield_variance_quantity: varianceQty,
      yield_variance_percent: variancePercent,
      input_cost: Number(inputCost.toFixed(4)),
      unit_cost: unitCost,
      output_movement_id: outputMovementId,
      completed_at: stamp,
      completed_by: userId,
      notes: input.notes ?? production.notes,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", production.id)
    .select("id, production_number, actual_quantity, yield_variance_percent, input_cost, unit_cost")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.production.completed",
    tenantId: input.tenantId,
    propertyId: production.property_id ?? undefined,
    locationId: production.output_location_id ?? undefined,
    entityType: "restaurant_production",
    entityId: production.id,
    source: "restaurant-os",
    payload: {
      production_number: production.production_number,
      planned_quantity: planned,
      actual_quantity: actual,
      input_cost: Number(inputCost.toFixed(4)),
      unit_cost: unitCost,
    },
    dedupeKey: `production-completed:${production.id}`,
  });

  if (variancePercent != null && Math.abs(variancePercent) >= 5) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.production.variance.detected",
      tenantId: input.tenantId,
      propertyId: production.property_id ?? undefined,
      locationId: production.production_location_id ?? undefined,
      entityType: "restaurant_production",
      entityId: production.id,
      source: "restaurant-os",
      payload: {
        production_number: production.production_number,
        planned_quantity: planned,
        actual_quantity: actual,
        variance_quantity: varianceQty,
        variance_percent: variancePercent,
      },
      dedupeKey: `production-variance:${production.id}`,
    });
  }
  return updated;
}

export async function cancelProduction(sb: Sb, userId: string, input: z.infer<typeof cancelProductionSchema>) {
  await assertCapability(sb, userId, input.tenantId, "production.manage");
  const { data: production } = await sb
    .from("restaurant_productions")
    .select("id, production_number, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.productionId)
    .single();
  if (!production) throw new Error("Production run not found.");
  if (production.status === "completed") {
    throw new Error("A completed run has already moved stock — reverse its ledger entries instead of cancelling.");
  }
  const { error } = await sb
    .from("restaurant_productions")
    .update({ status: "cancelled", notes: input.reason ?? null })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.productionId);
  if (error) throw new Error(error.message);
  return { id: input.productionId, status: "cancelled" as const };
}
