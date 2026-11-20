/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { randomUUID } from "node:crypto";
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
    .upsert(
      {
        tenant_id: input.tenantId,
        property_id: input.propertyId,
        location_id: input.locationId ?? null,
        driver_key: input.driverKey,
        period_start: input.periodStart,
        units: input.units,
        created_by: userId,
      },
      { onConflict: "tenant_id,property_id,location_id,driver_key,period_start" },
    )
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
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      propertyId: z.string().uuid().optional(),
    })
    .parse(input);
  await assertTenantRead(sb, userId, parsed.tenantId, { propertyId: parsed.propertyId ?? null });
  let query = sb
    .from("restaurant_cost_activity_drivers")
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
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      movementId: z.string().uuid(),
      driverKey: z
        .string()
        .regex(/^[a-z][a-z0-9_]{1,63}$/)
        .optional(),
      unallocatedReason: z.string().trim().min(3).max(500).optional(),
    })
    .parse(input);
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
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(2).max(240),
  amount: z.number().positive().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expenseStatus: z.enum(["draft", "recorded"]).default("recorded"),
});
const expenseEditSchema = expenseInputSchema
  .omit({ expenseStatus: true })
  .extend({ expenseId: z.string().uuid() });
export async function listOperationalExpenses(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_operational_expenses")
    .select(
      "id,property_id,location_id,category_id,supplier_id,description,amount,currency,incurred_on,approval_status,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,expense_status,payment_status,paid_amount,created_by,created_at,updated_at,cancelled_by,cancelled_at,cancellation_reason",
    )
    .eq("tenant_id", tenantId)
    .order("incurred_on", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function listOperationalExpenseCategories(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_operational_expense_categories")
    .select("id,name,category_key,parent_category_id,description,sort_order")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("sort_order")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function listOperationalExpenseSuppliers(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_suppliers")
    .select("id,name,status")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("name")
    .limit(300);
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function assertExpenseReferences(
  sb: Sb,
  x: {
    tenantId: string;
    propertyId?: string | null;
    locationId?: string | null;
    categoryId: string;
    supplierId?: string | null;
    currency: string;
  },
) {
  const { data: category, error: categoryError } = await sb
    .from("restaurant_operational_expense_categories")
    .select("id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.categoryId)
    .eq("active", true)
    .maybeSingle();
  if (categoryError || !category)
    throw new Error("Expense category is not available in this tenant.");
  if (x.supplierId) {
    const { data: supplier, error } = await sb
      .from("restaurant_suppliers")
      .select("id")
      .eq("tenant_id", x.tenantId)
      .eq("id", x.supplierId)
      .eq("status", "active")
      .maybeSingle();
    if (error || !supplier) throw new Error("Expense supplier is not available in this tenant.");
  }
  if (x.locationId && !x.propertyId) throw new Error("A location requires a property.");
  if (x.propertyId) {
    const { data: property, error } = await sb
      .from("restaurant_properties")
      .select("currency")
      .eq("id", x.propertyId)
      .eq("tenant_id", x.tenantId)
      .maybeSingle();
    if (error || !property) throw new Error("Expense property is not available in this tenant.");
    if (property.currency !== x.currency)
      throw new Error(
        `Expense currency must match the selected property's currency (${property.currency}).`,
      );
  }
  if (x.locationId) {
    const { data: loc, error } = await sb
      .from("restaurant_locations")
      .select("id")
      .eq("id", x.locationId)
      .eq("tenant_id", x.tenantId)
      .eq("property_id", x.propertyId)
      .maybeSingle();
    if (error || !loc) throw new Error("Location does not belong to the selected property.");
  }
}
export async function createOperationalExpense(sb: Sb, userId: string, raw: unknown) {
  const x = expenseInputSchema.parse(raw);
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: x.propertyId ?? null,
    locationId: x.locationId ?? null,
  });
  await assertExpenseReferences(sb, x);
  const { data, error } = await sb
    .from("restaurant_operational_expenses")
    .insert({
      tenant_id: x.tenantId,
      property_id: x.propertyId ?? null,
      location_id: x.locationId ?? null,
      category_id: x.categoryId,
      supplier_id: x.supplierId ?? null,
      description: x.description,
      amount: x.amount,
      currency: x.currency,
      incurred_on: x.incurredOn,
      created_by: userId,
      expense_status: x.expenseStatus,
    })
    .select("id,expense_status")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
export async function updateOperationalExpense(sb: Sb, userId: string, raw: unknown) {
  const x = expenseEditSchema.parse(raw);
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: x.propertyId ?? null,
    locationId: x.locationId ?? null,
  });
  const { data: existing, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,expense_status,approval_status,property_id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (readError || !existing) throw new Error("Expense not found.");
  if (
    !["draft", "recorded"].includes(existing.expense_status) ||
    existing.approval_status !== "pending"
  )
    throw new Error("Only draft or recorded pending expenses can be edited.");
  await assertExpenseReferences(sb, x);
  const { error } = await sb
    .from("restaurant_operational_expenses")
    .update({
      property_id: x.propertyId ?? null,
      location_id: x.locationId ?? null,
      category_id: x.categoryId,
      supplier_id: x.supplierId ?? null,
      description: x.description,
      amount: x.amount,
      currency: x.currency,
      incurred_on: x.incurredOn,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId);
  if (error) throw new Error(error.message);
  return { id: x.expenseId, updated: true };
}
export async function recordOperationalExpenseDraft(
  sb: Sb,
  userId: string,
  tenantId: string,
  expenseId: string,
) {
  await assertCapability(sb, userId, tenantId, "costing.manage");
  const { data: expense, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,expense_status,approval_status,property_id")
    .eq("tenant_id", tenantId)
    .eq("id", expenseId)
    .single();
  if (readError || !expense) throw new Error("Expense not found.");
  if (expense.expense_status !== "draft" || expense.approval_status !== "pending")
    throw new Error("Only a draft can be recorded.");
  await assertCapability(sb, userId, tenantId, "costing.manage", {
    propertyId: expense.property_id ?? null,
  });
  const { error } = await sb
    .from("restaurant_operational_expenses")
    .update({ expense_status: "recorded", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", expenseId)
    .eq("expense_status", "draft");
  if (error) throw new Error(error.message);
  return { id: expenseId, expenseStatus: "recorded" };
}
export async function approveOperationalExpense(
  sb: Sb,
  userId: string,
  tenantId: string,
  expenseId: string,
) {
  await assertCapability(sb, userId, tenantId, "costing.manage");
  const { data: expense, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,created_by,approval_status,expense_status,property_id")
    .eq("tenant_id", tenantId)
    .eq("id", expenseId)
    .single();
  if (readError || !expense) throw new Error("Expense not found.");
  if (expense.created_by === userId)
    throw new Error("Expense approval requires a different authorized user from its creator.");
  if (expense.approval_status !== "pending" || expense.expense_status !== "recorded")
    throw new Error("Only recorded pending expenses can be approved.");
  await assertCapability(sb, userId, tenantId, "costing.manage", {
    propertyId: expense.property_id ?? null,
  });
  const { error } = await sb
    .from("restaurant_operational_expenses")
    .update({
      approval_status: "approved",
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("id", expenseId)
    .eq("approval_status", "pending");
  if (error) throw new Error(error.message);
  return { approved: true };
}
export async function rejectOperationalExpense(
  sb: Sb,
  userId: string,
  input: { tenantId: string; expenseId: string; reason: string },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      expenseId: z.string().uuid(),
      reason: z.string().trim().min(3).max(500),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: e, error } = await sb
    .from("restaurant_operational_expenses")
    .select("id,created_by,approval_status,expense_status,property_id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (error || !e) throw new Error("Expense not found.");
  if (e.created_by === userId)
    throw new Error("Expense rejection requires a different authorized user from its creator.");
  if (e.approval_status !== "pending" || e.expense_status !== "recorded")
    throw new Error("Only recorded pending expenses can be rejected.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: e.property_id ?? null,
  });
  const { error: upError } = await sb
    .from("restaurant_operational_expenses")
    .update({
      approval_status: "rejected",
      rejected_by: userId,
      rejected_at: new Date().toISOString(),
      rejection_reason: x.reason,
    })
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .eq("approval_status", "pending");
  if (upError) throw new Error(upError.message);
  return { id: x.expenseId, rejected: true };
}
export async function cancelOperationalExpense(
  sb: Sb,
  userId: string,
  input: { tenantId: string; expenseId: string; reason: string },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      expenseId: z.string().uuid(),
      reason: z.string().trim().min(3).max(500),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: e, error } = await sb
    .from("restaurant_operational_expenses")
    .select("id,expense_status,approval_status,property_id,paid_amount")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (error || !e) throw new Error("Expense not found.");
  if (
    !["draft", "recorded"].includes(e.expense_status) ||
    e.approval_status !== "pending" ||
    Number(e.paid_amount) > 0
  )
    throw new Error("Only unpaid draft or recorded expenses can be cancelled.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: e.property_id ?? null,
  });
  const { error: upError } = await sb
    .from("restaurant_operational_expenses")
    .update({
      expense_status: "cancelled",
      cancelled_by: userId,
      cancelled_at: new Date().toISOString(),
      cancellation_reason: x.reason,
    })
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId);
  if (upError) throw new Error(upError.message);
  return { id: x.expenseId, cancelled: true };
}
export async function recordOperationalExpensePayment(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    expenseId: string;
    amount: number;
    currency: string;
    reference?: string;
  },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      expenseId: z.string().uuid(),
      amount: z.number().positive().finite(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      reference: z.string().trim().max(120).optional(),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: expense, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,approval_status,expense_status,currency,property_id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (readError || !expense) throw new Error("Expense not found.");
  if (
    expense.approval_status !== "approved" ||
    !["approved", "partially_paid"].includes(expense.expense_status)
  )
    throw new Error("Only approved expenses can be paid.");
  if (expense.currency !== x.currency)
    throw new Error("Payment currency must match expense currency.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: expense.property_id ?? null,
  });
  const { data, error } = await sb
    .from("restaurant_operational_expense_payments")
    .insert({
      tenant_id: x.tenantId,
      expense_id: x.expenseId,
      amount: x.amount,
      currency: x.currency,
      reference: x.reference ?? null,
      recorded_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
export async function allocateOperationalExpenseDirect(
  sb: Sb,
  userId: string,
  input: { tenantId: string; expenseId: string },
) {
  const x = z.object({ tenantId: z.string().uuid(), expenseId: z.string().uuid() }).parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: e, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,property_id,location_id,amount,currency,incurred_on,approval_status")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (readError || !e) throw new Error("Expense not found.");
  if (e.approval_status !== "approved") throw new Error("Only approved expenses can be allocated.");
  if (!e.property_id)
    throw new Error(
      "Shared expenses require an approved allocation rule or activity-driver allocation.",
    );
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: e.property_id,
    locationId: e.location_id ?? null,
  });
  const { data, error } = await sb.rpc("restaurant_commit_expense_allocations", {
    p_expense_id: e.id,
    p_unallocated_reason: null,
    p_allocations: [
      {
        property_id: e.property_id,
        location_id: e.location_id,
        amount: Number(e.amount),
        currency: e.currency,
        allocation_method: "direct",
      },
    ],
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function createOperationalExpenseCategory(
  sb: Sb,
  userId: string,
  input: { tenantId: string; name: string; categoryKey: string; parentCategoryId?: string | null },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      name: z.string().trim().min(2).max(80),
      categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
      parentCategoryId: z.string().uuid().nullable().optional(),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  if (x.parentCategoryId) {
    const { data: parent, error: parentError } = await sb
      .from("restaurant_operational_expense_categories")
      .select("id,parent_category_id")
      .eq("tenant_id", x.tenantId)
      .eq("id", x.parentCategoryId)
      .eq("active", true)
      .maybeSingle();
    if (parentError || !parent || parent.parent_category_id)
      throw new Error("Choose an active top-level category for the subcategory.");
  }
  const { data, error } = await sb
    .from("restaurant_operational_expense_categories")
    .insert({
      tenant_id: x.tenantId,
      name: x.name,
      category_key: x.categoryKey,
      parent_category_id: x.parentCategoryId ?? null,
      active: true,
    })
    .select("id,name,category_key,parent_category_id")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

const recurringScheduleSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(2).max(240),
  amount: z.number().positive().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  cadence: z.enum(["weekly", "monthly", "quarterly", "annually"]),
  nextOccurrence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export async function listRecurringExpenseSchedules(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_operational_expense_schedules")
    .select(
      "id,property_id,location_id,category_id,supplier_id,description,amount,currency,cadence,next_occurrence,ends_on,active,created_at,updated_at",
    )
    .eq("tenant_id", tenantId)
    .order("next_occurrence");
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function createRecurringExpenseSchedule(sb: Sb, userId: string, input: unknown) {
  const x = recurringScheduleSchema.parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: x.propertyId ?? null,
    locationId: x.locationId ?? null,
  });
  await assertExpenseReferences(sb, x);
  const { data, error } = await sb
    .from("restaurant_operational_expense_schedules")
    .insert({
      tenant_id: x.tenantId,
      property_id: x.propertyId ?? null,
      location_id: x.locationId ?? null,
      category_id: x.categoryId,
      supplier_id: x.supplierId ?? null,
      description: x.description,
      amount: x.amount,
      currency: x.currency,
      cadence: x.cadence,
      next_occurrence: x.nextOccurrence,
      ends_on: x.endsOn ?? null,
      created_by: userId,
      active: true,
    })
    .select("id,description,cadence,next_occurrence,active")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
export async function updateRecurringExpenseSchedule(sb: Sb, userId: string, input: unknown) {
  const x = recurringScheduleSchema.extend({ scheduleId: z.string().uuid() }).parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: x.propertyId ?? null,
    locationId: x.locationId ?? null,
  });
  await assertExpenseReferences(sb, x);
  const { data: existing, error: readError } = await sb
    .from("restaurant_operational_expense_schedules")
    .select("id,property_id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.scheduleId)
    .single();
  if (readError || !existing) throw new Error("Recurring expense schedule not found.");
  const { error } = await sb
    .from("restaurant_operational_expense_schedules")
    .update({
      property_id: x.propertyId ?? null,
      location_id: x.locationId ?? null,
      category_id: x.categoryId,
      supplier_id: x.supplierId ?? null,
      description: x.description,
      amount: x.amount,
      currency: x.currency,
      cadence: x.cadence,
      next_occurrence: x.nextOccurrence,
      ends_on: x.endsOn ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", x.tenantId)
    .eq("id", x.scheduleId);
  if (error) throw new Error(error.message);
  return { id: x.scheduleId, updated: true };
}
export async function setRecurringExpenseScheduleActive(
  sb: Sb,
  userId: string,
  input: { tenantId: string; scheduleId: string; active: boolean },
) {
  const x = z
    .object({ tenantId: z.string().uuid(), scheduleId: z.string().uuid(), active: z.boolean() })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: s, error: readError } = await sb
    .from("restaurant_operational_expense_schedules")
    .select("id,property_id")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.scheduleId)
    .single();
  if (readError || !s) throw new Error("Recurring expense schedule not found.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: s.property_id ?? null,
  });
  const { error } = await sb
    .from("restaurant_operational_expense_schedules")
    .update({ active: x.active, updated_at: new Date().toISOString() })
    .eq("tenant_id", x.tenantId)
    .eq("id", x.scheduleId);
  if (error) throw new Error(error.message);
  return { id: x.scheduleId, active: x.active };
}
export async function generateRecurringExpenseOccurrence(
  sb: Sb,
  userId: string,
  input: { tenantId: string; scheduleId: string; occurrenceDate: string },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      scheduleId: z.string().uuid(),
      occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(input);
  const { data: s, error: readError } = await sb
    .from("restaurant_operational_expense_schedules")
    .select("id,property_id,active")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.scheduleId)
    .single();
  if (readError || !s || !s.active) throw new Error("Active recurring expense schedule not found.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: s.property_id ?? null,
  });
  const { data, error } = await sb.rpc("restaurant_generate_scheduled_expense", {
    p_schedule_id: x.scheduleId,
    p_occurrence_date: x.occurrenceDate,
  });
  if (error) throw new Error(error.message);
  return { expenseId: data };
}
export async function listOperationalExpenseAuditEvents(
  sb: Sb,
  userId: string,
  tenantId: string,
  expenseId: string,
) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_operational_expense_audit_events")
    .select("id,event_type,actor_id,reason,before_state,after_state,metadata,created_at")
    .eq("tenant_id", tenantId)
    .eq("expense_id", expenseId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function listOperationalExpenseScheduleAuditEvents(
  sb: Sb,
  userId: string,
  tenantId: string,
  scheduleId: string,
) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_operational_expense_audit_events")
    .select("id,event_type,actor_id,reason,before_state,after_state,metadata,created_at")
    .eq("tenant_id", tenantId)
    .eq("schedule_id", scheduleId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}
export const EXPENSE_ATTACHMENT_BUCKET = "restaurant-expense-attachments";
const EXPENSE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const EXPENSE_ATTACHMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export async function uploadOperationalExpenseAttachment(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    expenseId: string;
    fileName: string;
    mimeType: string;
    fileBase64: string;
  },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      expenseId: z.string().uuid(),
      fileName: z.string().trim().min(1).max(180),
      mimeType: z.enum(EXPENSE_ATTACHMENT_TYPES),
      fileBase64: z
        .string()
        .min(1)
        .max(Math.ceil((EXPENSE_ATTACHMENT_MAX_BYTES * 4) / 3) + 1024),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: e, error: readError } = await sb
    .from("restaurant_operational_expenses")
    .select("id,property_id,expense_status")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.expenseId)
    .single();
  if (readError || !e) throw new Error("Expense not found.");
  if (!["draft", "recorded"].includes(e.expense_status))
    throw new Error("Evidence can only be added before approval.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: e.property_id ?? null,
  });
  const buffer = Buffer.from(x.fileBase64, "base64");
  if (!buffer.length) throw new Error("The selected file is empty.");
  if (buffer.length > EXPENSE_ATTACHMENT_MAX_BYTES)
    throw new Error("Attachment exceeds the 10MB limit.");
  const isPng =
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg =
    buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (
    (x.mimeType === "application/pdf" && !isPdf) ||
    (x.mimeType === "image/jpeg" && !isJpeg) ||
    (x.mimeType === "image/png" && !isPng) ||
    (x.mimeType === "image/webp" && !isWebp)
  )
    throw new Error("File content does not match its declared type.");
  const ext: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const path = `${x.tenantId}/${x.expenseId}/${userId}/${randomUUID()}.${ext[x.mimeType]}`;
  const { error: uploadError } = await sb.storage
    .from(EXPENSE_ATTACHMENT_BUCKET)
    .upload(path, buffer, { contentType: x.mimeType, upsert: false });
  if (uploadError) throw new Error(uploadError.message);
  const { data: attachment, error } = await sb
    .from("restaurant_operational_expense_attachments")
    .insert({
      tenant_id: x.tenantId,
      expense_id: x.expenseId,
      storage_path: path,
      file_name: x.fileName,
      mime_type: x.mimeType,
      size_bytes: buffer.length,
      uploaded_by: userId,
    })
    .select("id,file_name,mime_type,size_bytes,created_at")
    .single();
  if (error) {
    await sb.storage.from(EXPENSE_ATTACHMENT_BUCKET).remove([path]);
    throw new Error(error.message);
  }
  return attachment;
}
export async function listOperationalExpenseAttachments(
  sb: Sb,
  userId: string,
  tenantId: string,
  expenseId: string,
) {
  await assertTenantRead(sb, userId, tenantId);
  const { data: rows, error } = await sb
    .from("restaurant_operational_expense_attachments")
    .select("id,storage_path,file_name,mime_type,size_bytes,uploaded_by,created_at")
    .eq("tenant_id", tenantId)
    .eq("expense_id", expenseId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return await Promise.all(
    (rows ?? []).map(async (row: any) => {
      const { data, error: signedError } = await sb.storage
        .from(EXPENSE_ATTACHMENT_BUCKET)
        .createSignedUrl(row.storage_path, 300);
      if (signedError) throw new Error(signedError.message);
      return { ...row, signedUrl: data.signedUrl, canRemove: row.uploaded_by === userId };
    }),
  );
}
export async function removeOperationalExpenseAttachment(
  sb: Sb,
  userId: string,
  input: { tenantId: string; attachmentId: string },
) {
  const x = z.object({ tenantId: z.string().uuid(), attachmentId: z.string().uuid() }).parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const { data: a, error } = await sb
    .from("restaurant_operational_expense_attachments")
    .select("id,expense_id,storage_path,uploaded_by")
    .eq("tenant_id", x.tenantId)
    .eq("id", x.attachmentId)
    .single();
  if (error || !a) throw new Error("Attachment not found.");
  if (a.uploaded_by !== userId) throw new Error("Only the uploader can remove this attachment.");
  const { data: e, error: expenseError } = await sb
    .from("restaurant_operational_expenses")
    .select("property_id,expense_status")
    .eq("tenant_id", x.tenantId)
    .eq("id", a.expense_id)
    .single();
  if (expenseError || !e || !["draft", "recorded"].includes(e.expense_status))
    throw new Error("Evidence is locked after approval.");
  await assertCapability(sb, userId, x.tenantId, "costing.manage", {
    propertyId: e.property_id ?? null,
  });
  const { error: removeError } = await sb.storage
    .from(EXPENSE_ATTACHMENT_BUCKET)
    .remove([a.storage_path]);
  if (removeError) throw new Error(removeError.message);
  const { error: deleteError } = await sb
    .from("restaurant_operational_expense_attachments")
    .delete()
    .eq("tenant_id", x.tenantId)
    .eq("id", x.attachmentId);
  if (deleteError) throw new Error(deleteError.message);
  return { removed: true };
}
// Shared-expense allocation rule lifecycle.
const allocationRuleInputSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(2).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  targets: z
    .array(
      z.object({
        propertyId: z.string().uuid(),
        locationId: z.string().uuid().nullable().optional(),
        weight: z.number().positive().finite(),
      }),
    )
    .min(2)
    .max(50),
});
export async function listCostAllocationRules(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_cost_allocation_rules")
    .select(
      "id,name,currency,effective_from,effective_to,version,targets,status,created_by,approved_by",
    )
    .eq("tenant_id", tenantId)
    .order("name")
    .order("version", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function createCostAllocationRule(sb: Sb, userId: string, raw: unknown) {
  const x = allocationRuleInputSchema.parse(raw);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  if (x.effectiveTo && x.effectiveTo < x.effectiveFrom)
    throw new Error("Rule end date cannot precede its start date.");
  const seen = new Set<string>();
  const targets = [];
  for (const target of x.targets) {
    const key = target.propertyId + ":" + (target.locationId ?? "");
    if (seen.has(key)) throw new Error("Allocation rule targets must be unique.");
    seen.add(key);
    await assertCapability(sb, userId, x.tenantId, "costing.manage", {
      propertyId: target.propertyId,
      locationId: target.locationId ?? null,
    });
    if (target.locationId) {
      const { data: location } = await sb
        .from("restaurant_locations")
        .select("id")
        .eq("id", target.locationId)
        .eq("tenant_id", x.tenantId)
        .eq("property_id", target.propertyId)
        .maybeSingle();
      if (!location) throw new Error("A rule location must belong to its selected property.");
    }
    targets.push({
      property_id: target.propertyId,
      location_id: target.locationId ?? null,
      weight: target.weight,
    });
  }
  const { data: prior, error: priorError } = await sb
    .from("restaurant_cost_allocation_rules")
    .select("version")
    .eq("tenant_id", x.tenantId)
    .eq("name", x.name)
    .order("version", { ascending: false })
    .limit(1);
  if (priorError) throw new Error(priorError.message);
  const version = (prior?.[0]?.version ?? 0) + 1;
  const { data, error } = await sb
    .from("restaurant_cost_allocation_rules")
    .insert({
      tenant_id: x.tenantId,
      name: x.name,
      currency: x.currency,
      effective_from: x.effectiveFrom,
      effective_to: x.effectiveTo ?? null,
      version,
      targets,
      status: "draft",
      created_by: userId,
    })
    .select("id,name,currency,effective_from,effective_to,version,targets,status,created_by")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
export async function approveCostAllocationRule(
  sb: Sb,
  userId: string,
  tenantId: string,
  ruleId: string,
) {
  await assertCapability(sb, userId, tenantId, "costing.manage");
  const { data: rule, error: readError } = await sb
    .from("restaurant_cost_allocation_rules")
    .select("id,created_by,status,targets")
    .eq("tenant_id", tenantId)
    .eq("id", ruleId)
    .single();
  if (readError || !rule) throw new Error("Allocation rule not found.");
  if (rule.created_by === userId)
    throw new Error("Rule approval requires a different authorized user from its creator.");
  if (rule.status !== "draft") throw new Error("Only draft allocation rules can be approved.");
  for (const target of rule.targets as Array<{
    property_id: string;
    location_id?: string | null;
  }>) {
    await assertCapability(sb, userId, tenantId, "costing.manage", {
      propertyId: target.property_id,
      locationId: target.location_id ?? null,
    });
  }
  const { data, error } = await sb
    .from("restaurant_cost_allocation_rules")
    .update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", ruleId)
    .eq("status", "draft")
    .select("id,status,approved_by")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Rule approval was concurrently changed; refresh and retry.");
  return data;
}
export async function allocateOperationalExpenseByRule(
  sb: Sb,
  userId: string,
  input: { tenantId: string; expenseId: string; ruleId: string },
) {
  const x = z
    .object({
      tenantId: z.string().uuid(),
      expenseId: z.string().uuid(),
      ruleId: z.string().uuid(),
    })
    .parse(input);
  await assertCapability(sb, userId, x.tenantId, "costing.manage");
  const [{ data: expense, error: expenseError }, { data: rule, error: ruleError }] =
    await Promise.all([
      sb
        .from("restaurant_operational_expenses")
        .select("id,amount,currency,incurred_on,approval_status,property_id")
        .eq("tenant_id", x.tenantId)
        .eq("id", x.expenseId)
        .single(),
      sb
        .from("restaurant_cost_allocation_rules")
        .select("id,currency,effective_from,effective_to,version,targets,status")
        .eq("tenant_id", x.tenantId)
        .eq("id", x.ruleId)
        .single(),
    ]);
  if (expenseError || !expense) throw new Error("Expense not found.");
  if (ruleError || !rule) throw new Error("Allocation rule not found.");
  if (expense.approval_status !== "approved")
    throw new Error("Only approved expenses can be allocated.");
  if (
    rule.status !== "approved" ||
    rule.currency !== expense.currency ||
    rule.effective_from > expense.incurred_on ||
    (rule.effective_to && rule.effective_to < expense.incurred_on)
  )
    throw new Error("Rule is not approved, currency-matched and effective for this expense.");
  const targets = rule.targets as Array<{
    property_id: string;
    location_id: string | null;
    weight: number;
  }>;
  const totalWeight = targets.reduce((sum, t) => sum + Number(t.weight), 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0)
    throw new Error("Allocation rule weights are invalid.");
  for (const target of targets)
    await assertCapability(sb, userId, x.tenantId, "costing.manage", {
      propertyId: target.property_id,
      locationId: target.location_id ?? null,
    });
  const cents = Math.round(Number(expense.amount) * 100);
  const shares = targets.map((t, index) => {
    const raw = (cents * Number(t.weight)) / totalWeight;
    return { ...t, index, cents: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  const remaining = cents - shares.reduce((sum, t) => sum + t.cents, 0);
  [...shares]
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        a.property_id.localeCompare(b.property_id) ||
        (a.location_id ?? "").localeCompare(b.location_id ?? ""),
    )
    .slice(0, remaining)
    .forEach((t) => {
      shares[t.index].cents += 1;
    });
  const allocations = shares.map((t) => ({
    property_id: t.property_id,
    location_id: t.location_id,
    amount: t.cents / 100,
    currency: expense.currency,
    allocation_method: "approved_rule",
    rule_id: rule.id,
    rule_version: rule.version,
  }));
  const { data, error } = await sb.rpc("restaurant_commit_expense_allocations", {
    p_expense_id: expense.id,
    p_allocations: allocations,
    p_unallocated_reason: null,
  });
  if (error) throw new Error(error.message);
  return data;
}
