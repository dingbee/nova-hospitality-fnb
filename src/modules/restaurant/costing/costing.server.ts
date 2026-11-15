/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import {
  computeRecipeCostSchema,
  recipeSchema,
  upsertRecipeComponentSchema,
  type ComputeRecipeCostInput,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { componentToStock, type UnitRow } from "../inventory/units";

type Sb = any;

export async function listRecipeComponents(
  sb: Sb,
  userId: string,
  input: z.infer<typeof recipeSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_components")
    .select(
      "id, menu_item_id, inventory_item_id, component_menu_item_id, unit_id, quantity, yield_percent, notes",
    )
    .eq("tenant_id", input.tenantId)
    .eq("menu_item_id", input.menuItemId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertRecipeComponent(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertRecipeComponentSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "costing.manage");
  const row = {
    tenant_id: input.tenantId,
    menu_item_id: input.menuItemId,
    inventory_item_id: input.inventoryItemId ?? null,
    unit_id: input.unitId ?? null,
    quantity: input.quantity,
    yield_percent: input.yieldPercent,
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb
        .from("restaurant_recipe_components")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_recipe_components").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.recipe.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: { component_id: data.id, quantity: input.quantity },
  });
  return data;
}

/**
 * Deterministic recipe costing. No AI, no hidden assumptions:
 * ingredient cost = Σ (quantity ÷ yield) × average unit cost.
 */
export async function computeRecipeCost(sb: Sb, userId: string, input: ComputeRecipeCostInput) {
  await assertCapability(sb, userId, input.tenantId, "costing.manage");

  const [{ data: item }, { data: components }] = await Promise.all([
    sb
      .from("restaurant_menu_items")
      .select("id, name, price, currency")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.menuItemId)
      .single(),
    sb
      .from("restaurant_recipe_components")
      .select("quantity, yield_percent, inventory_item_id, unit_id")
      .eq("tenant_id", input.tenantId)
      .eq("menu_item_id", input.menuItemId),
  ]);
  if (!item) throw new Error("Menu item not found.");

  const ids = (components ?? []).map((c: any) => c.inventory_item_id).filter(Boolean);
  const costs = new Map<string, { cost: number; name: string; unit_id: string | null }>();
  if (ids.length > 0) {
    const { data: inv } = await sb
      .from("restaurant_inventory_items")
      .select("id, name, average_cost, unit_id, content_per_stock_unit, content_unit_id")
      .in("id", ids);
    for (const row of (inv ?? []) as any[]) {
      costs.set(row.id, {
        cost: Number(row.average_cost ?? 0),
        name: row.name,
        unit_id: row.unit_id ?? null,
      });
    }
  }

  // average_cost is priced per the item's own stock unit — a component
  // whose recipe line was entered in a different unit (a KG item consumed
  // in G, say) must be converted before that price applies, or a gram
  // silently costs as much as a kilogram (see units.ts#componentToStock).
  const unitIds = [
    ...new Set(
      [
        ...(components ?? []).map((c: any) => c.unit_id),
        ...[...costs.values()].map((v) => v.unit_id),
      ].filter(Boolean),
    ),
  ] as string[];
  const { data: unitRows } = unitIds.length
    ? await sb
        .from("restaurant_inventory_units")
        .select("id, code, name, dimension, factor, base_unit_id")
        .in("id", unitIds)
    : { data: [] as any[] };
  const unitById = new Map(((unitRows ?? []) as UnitRow[]).map((u) => [u.id, u]));

  const breakdown: Array<{
    inventory_item_id: string | null;
    name: string;
    quantity: number;
    yield_percent: number;
    unit_cost: number;
    line_cost: number;
  }> = (components ?? []).map((c: any) => {
    const meta = c.inventory_item_id ? costs.get(c.inventory_item_id) : undefined;
    const effectiveQty = Number(c.quantity) / (Number(c.yield_percent ?? 100) / 100);
    if (!meta) {
      return {
        inventory_item_id: c.inventory_item_id,
        name: "Unmapped component",
        quantity: Number(c.quantity),
        yield_percent: Number(c.yield_percent ?? 100),
        unit_cost: 0,
        line_cost: 0,
      };
    }
    const converted = componentToStock(effectiveQty, c.unit_id, meta, unitById);
    if (!converted.exact) {
      return {
        inventory_item_id: c.inventory_item_id,
        name: `${meta.name} (unit mismatch — not costed)`,
        quantity: Number(c.quantity),
        yield_percent: Number(c.yield_percent ?? 100),
        unit_cost: 0,
        line_cost: 0,
      };
    }
    const lineCost = converted.quantity * meta.cost;
    return {
      inventory_item_id: c.inventory_item_id,
      name: meta.name,
      quantity: Number(c.quantity),
      yield_percent: Number(c.yield_percent ?? 100),
      unit_cost: meta.cost,
      line_cost: Number(lineCost.toFixed(4)),
    };
  });

  const ingredientCost = breakdown.reduce((s, b) => s + b.line_cost, 0);
  const totalCost = ingredientCost + input.overheadCost;
  const price = Number(item.price ?? 0);
  const foodCostPercent = price > 0 ? Number(((totalCost / price) * 100).toFixed(2)) : null;
  const targetMargin = input.targetMargin ?? null;
  const suggestedPrice =
    targetMargin != null && targetMargin < 100
      ? Number((totalCost / (1 - targetMargin / 100)).toFixed(2))
      : null;

  const { data: saved, error } = await sb
    .from("restaurant_recipe_costs")
    .insert({
      tenant_id: input.tenantId,
      menu_item_id: input.menuItemId,
      ingredient_cost: Number(ingredientCost.toFixed(4)),
      overhead_cost: input.overheadCost,
      total_cost: Number(totalCost.toFixed(4)),
      target_margin: targetMargin,
      suggested_price: suggestedPrice,
      food_cost_percent: foodCostPercent,
      currency: item.currency ?? "TZS",
      breakdown,
    })
    .select("id, computed_at")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.cost.changed",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      total_cost: Number(totalCost.toFixed(4)),
      food_cost_percent: foodCostPercent,
      price,
    },
  });

  return {
    id: saved.id,
    computedAt: saved.computed_at,
    ingredientCost: Number(ingredientCost.toFixed(4)),
    overheadCost: input.overheadCost,
    totalCost: Number(totalCost.toFixed(4)),
    price,
    foodCostPercent,
    suggestedPrice,
    currency: item.currency ?? "TZS",
    breakdown,
  };
}

export async function listRecipeCosts(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_costs")
    .select(
      "id, menu_item_id, computed_at, total_cost, food_cost_percent, suggested_price, currency",
    )
    .eq("tenant_id", tenantId)
    .order("computed_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const _schemas = { computeRecipeCostSchema };


const activityDriverInputSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  units: z.number().positive().finite(),
});

export async function upsertCostActivityDriver(sb: Sb, userId: string, rawInput: unknown) {
  const input = activityDriverInputSchema.parse(rawInput);
  await assertCapability(sb, userId, input.tenantId, "costing.manage", {
    propertyId: input.propertyId,
    locationId: input.locationId ?? null,
  });
  const { data, error } = await sb
    .from("restaurant_cost_activity_drivers")
    .upsert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: input.locationId ?? null,
      driver_key: input.driverKey,
      period_start: input.periodStart,
      units: input.units,
      created_by: userId,
    }, { onConflict: "tenant_id,property_id,location_id,driver_key,period_start" })
    .select("id, property_id, location_id, driver_key, period_start, units, captured_at")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listCostActivityDrivers(
  sb: Sb,
  userId: string,
  input: { tenantId: string; driverKey: string; periodStart: string; propertyId?: string },
) {
  const parsed = z.object({
    tenantId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    propertyId: z.string().uuid().optional(),
  }).parse(input);
  await assertTenantRead(sb, userId, parsed.tenantId, { propertyId: parsed.propertyId ?? null });
  let query = sb.from("restaurant_cost_activity_drivers")
    .select("id, property_id, location_id, driver_key, period_start, units, captured_at")
    .eq("tenant_id", parsed.tenantId)
    .eq("driver_key", parsed.driverKey)
    .eq("period_start", parsed.periodStart)
    .order("property_id", { ascending: true });
  if (parsed.propertyId) query = query.eq("property_id", parsed.propertyId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function commitConsumptionAllocation(
  sb: Sb,
  userId: string,
  input: { tenantId: string; movementId: string; driverKey?: string; unallocatedReason?: string },
) {
  const parsed = z.object({
    tenantId: z.string().uuid(),
    movementId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    unallocatedReason: z.string().trim().min(3).max(500).optional(),
  }).parse(input);
  await assertCapability(sb, userId, parsed.tenantId, "costing.manage");
  const { data, error } = await sb.rpc("restaurant_commit_consumption_allocation", {
    p_movement_id: parsed.movementId,
    p_unallocated_reason: parsed.unallocatedReason ?? null,
    p_driver_key: parsed.driverKey ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}


// Operational expense lifecycle. Every write is capability-checked and tenant-scoped.
const expenseInputSchema = z.object({
  tenantId: z.string().uuid(), propertyId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(), categoryId: z.string().uuid(),
  description: z.string().trim().min(2).max(240), amount: z.number().positive().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/), incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export async function listOperationalExpenses(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb,userId,tenantId);
  const {data,error}=await sb.from("restaurant_operational_expenses")
    .select("id,property_id,location_id,category_id,description,amount,currency,incurred_on,approval_status,approved_by,payment_status,paid_amount,created_by,created_at")
    .eq("tenant_id",tenantId).order("incurred_on",{ascending:false}).limit(200);
  if(error) throw new Error(error.message); return data??[];
}
export async function listOperationalExpenseCategories(sb: Sb,userId:string,tenantId:string) {
  await assertTenantRead(sb,userId,tenantId);
  const {data,error}=await sb.from("restaurant_operational_expense_categories")
    .select("id,name,category_key").eq("tenant_id",tenantId).eq("active",true).order("name");
  if(error) throw new Error(error.message); return data??[];
}
export async function createOperationalExpense(sb:Sb,userId:string,raw:unknown) {
  const x=expenseInputSchema.parse(raw);
  await assertCapability(sb,userId,x.tenantId,"costing.manage",{propertyId:x.propertyId??null,locationId:x.locationId??null});
  const {data:category,error:categoryError}=await sb.from("restaurant_operational_expense_categories")
    .select("id").eq("tenant_id",x.tenantId).eq("id",x.categoryId).eq("active",true).maybeSingle();
  if(categoryError||!category) throw new Error("Expense category is not available in this tenant.");
  if(x.locationId && !x.propertyId) throw new Error("A location requires a property.");
  if(x.locationId) {
    const {data:loc}=await sb.from("restaurant_locations").select("id").eq("id",x.locationId).eq("tenant_id",x.tenantId).eq("property_id",x.propertyId).maybeSingle();
    if(!loc) throw new Error("Location does not belong to the selected property.");
  }
  const {data,error}=await sb.from("restaurant_operational_expenses").insert({
    tenant_id:x.tenantId,property_id:x.propertyId??null,location_id:x.locationId??null,
    category_id:x.categoryId,description:x.description,amount:x.amount,currency:x.currency,
    incurred_on:x.incurredOn,created_by:userId,
  }).select("id").single();
  if(error) throw new Error(error.message); return data;
}
export async function approveOperationalExpense(sb:Sb,userId:string,tenantId:string,expenseId:string) {
  await assertCapability(sb,userId,tenantId,"costing.manage");
  const {data:expense,error:readError}=await sb.from("restaurant_operational_expenses")
    .select("id,created_by,approval_status,property_id").eq("tenant_id",tenantId).eq("id",expenseId).single();
  if(readError||!expense) throw new Error("Expense not found.");
  if(expense.created_by===userId) throw new Error("Expense approval requires a different authorized user from its creator.");
  if(expense.approval_status!=="pending") throw new Error("Only pending expenses can be approved.");
  await assertCapability(sb,userId,tenantId,"costing.manage",{propertyId:expense.property_id??null});
  const {error}=await sb.from("restaurant_operational_expenses").update({approval_status:"approved",approved_by:userId,approved_at:new Date().toISOString()})
    .eq("tenant_id",tenantId).eq("id",expenseId).eq("approval_status","pending");
  if(error) throw new Error(error.message); return {approved:true};
}
export async function recordOperationalExpensePayment(sb:Sb,userId:string,input:{tenantId:string;expenseId:string;amount:number;currency:string;reference?:string}) {
  const x=z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid(),amount:z.number().positive().finite(),currency:z.string().regex(/^[A-Z]{3}$/),reference:z.string().trim().max(120).optional()}).parse(input);
  await assertCapability(sb,userId,x.tenantId,"costing.manage");
  const {data:expense,error:readError}=await sb.from("restaurant_operational_expenses").select("id,approval_status,currency,property_id")
    .eq("tenant_id",x.tenantId).eq("id",x.expenseId).single();
  if(readError||!expense) throw new Error("Expense not found.");
  if(expense.approval_status!=="approved") throw new Error("Only approved expenses can be paid.");
  if(expense.currency!==x.currency) throw new Error("Payment currency must match expense currency.");
  await assertCapability(sb,userId,x.tenantId,"costing.manage",{propertyId:expense.property_id??null});
  const {data,error}=await sb.from("restaurant_operational_expense_payments").insert({
    tenant_id:x.tenantId,expense_id:x.expenseId,amount:x.amount,currency:x.currency,reference:x.reference??null,recorded_by:userId,
  }).select("id").single();
  if(error) throw new Error(error.message); return data;
}
export async function allocateOperationalExpenseDirect(sb:Sb,userId:string,input:{tenantId:string;expenseId:string}) {
  const x=z.object({tenantId:z.string().uuid(),expenseId:z.string().uuid()}).parse(input);
  await assertCapability(sb,userId,x.tenantId,"costing.manage");
  const {data:e,error:readError}=await sb.from("restaurant_operational_expenses")
    .select("id,property_id,location_id,amount,currency,incurred_on,approval_status")
    .eq("tenant_id",x.tenantId).eq("id",x.expenseId).single();
  if(readError||!e) throw new Error("Expense not found.");
  if(e.approval_status!=="approved") throw new Error("Only approved expenses can be allocated.");
  if(!e.property_id) throw new Error("Shared expenses require an approved allocation rule or activity-driver allocation.");
  await assertCapability(sb,userId,x.tenantId,"costing.manage",{propertyId:e.property_id,locationId:e.location_id??null});
  const {data,error}=await sb.rpc("restaurant_commit_expense_allocations",{
    p_expense_id:e.id,p_unallocated_reason:null,
    p_allocations:[{property_id:e.property_id,location_id:e.location_id,amount:Number(e.amount),currency:e.currency,allocation_method:"direct"}],
  });
  if(error) throw new Error(error.message); return data;
}

export async function createOperationalExpenseCategory(sb:Sb,userId:string,input:{tenantId:string;name:string;categoryKey:string}) {
 const x=z.object({tenantId:z.string().uuid(),name:z.string().trim().min(2).max(80),categoryKey:z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)}).parse(input);
 await assertCapability(sb,userId,x.tenantId,"costing.manage");
 const {data,error}=await sb.from("restaurant_operational_expense_categories")
  .insert({tenant_id:x.tenantId,name:x.name,category_key:x.categoryKey,active:true})
  .select("id,name,category_key").single();
 if(error) throw new Error(error.message); return data;
}
