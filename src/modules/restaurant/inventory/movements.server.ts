/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Inventory Movement Engine.
 *
 * Stock levels are no longer edited directly: every change is a *movement*.
 * `restaurant_stock_movements` is the ledger; a database trigger applies each
 * movement to `restaurant_inventory_items` (quantity + weighted average cost)
 * and stamps `balance_after`, so the ledger and the balance can never diverge.
 */
import { z } from "zod";
import type {
  RecordMovementInput,
  StockMovementType,
  TransferStockInput,
  listMovementsSchema,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { evaluateNegativeStock } from "./policy";

type Sb = any;

/** Refusal raised when a movement would breach the tenant's negative-stock policy. */
export class NegativeStockError extends Error {
  readonly code = "negative_stock";
  constructor(
    message: string,
    readonly detail: { inventoryItemId: string; movementType: StockMovementType; shortfall: number },
  ) {
    super(message);
    this.name = "NegativeStockError";
  }
}

/** Direction is a property of the movement type, never of caller input. */
const OUTBOUND: readonly StockMovementType[] = [
  "consumption",
  "wastage",
  "transfer_out",
  "adjustment_out",
  "return_to_supplier",
];

export function signedQuantity(type: StockMovementType, magnitude: number, signedAllowed = false): number {
  // `adjustment` and `reversal` carry their own sign; everything else derives it.
  if (type === "adjustment" || type === "reversal") return signedAllowed ? magnitude : magnitude;
  return OUTBOUND.includes(type) ? -Math.abs(magnitude) : Math.abs(magnitude);
}

export async function listMovements(sb: Sb, userId: string, input: z.infer<typeof listMovementsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_stock_movements")
    .select(
      "id, inventory_item_id, movement_type, quantity, unit_cost, total_cost, balance_after, currency, reason, notes, occurred_at, location_id, destination_location_id, reference_type, reference_id",
    )
    .eq("tenant_id", input.tenantId)
    .order("occurred_at", { ascending: false })
    .limit(input.limit);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.inventoryItemId) q = q.eq("inventory_item_id", input.inventoryItemId);
  if (input.movementType) q = q.eq("movement_type", input.movementType);
  if (input.from) q = q.gte("occurred_at", input.from);
  if (input.to) q = q.lte("occurred_at", input.to);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Raw ledger write. All movement helpers funnel through here. */
export async function insertMovement(
  sb: Sb,
  userId: string,
  row: {
    tenantId: string;
    propertyId?: string | null;
    locationId?: string | null;
    destinationLocationId?: string | null;
    inventoryItemId: string;
    unitId?: string | null;
    movementType: StockMovementType;
    quantity: number;
    unitCost: number;
    currency: string;
    reason?: string | null;
    notes?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    orderItemId?: string | null;
    transferId?: string | null;
    transferLineId?: string | null;
    stocktakeId?: string | null;
    productionId?: string | null;
    batchId?: string | null;
    reversalOfId?: string | null;
    correlationId?: string | null;
    reasonCode?: string | null;
    approvedBy?: string | null;
    occurredAt?: string;
    dedupeKey?: string | null;
  },
) {
  // One policy for every stock-affecting path. Corrections and inbound
  // movements pass straight through; an outbound movement that would push the
  // balance below zero is refused unless the item allows it or a supervisor
  // has approved this specific movement.
  {
    const { data: item } = await sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, allow_negative")
      .eq("tenant_id", row.tenantId)
      .eq("id", row.inventoryItemId)
      .maybeSingle();
    if (item) {
      const decision = evaluateNegativeStock({
        movementType: row.movementType,
        quantity: row.quantity,
        currentQuantity: Number(item.current_quantity ?? 0),
        allowNegative: Boolean(item.allow_negative),
        approvedBy: row.approvedBy ?? null,
        itemName: item.name,
      });
      if (!decision.allowed) {
        throw new NegativeStockError(decision.message, {
          inventoryItemId: row.inventoryItemId,
          movementType: row.movementType,
          shortfall: decision.shortfall,
        });
      }
    }
  }

  const { data, error } = await sb
    .from("restaurant_stock_movements")
    .insert({
      tenant_id: row.tenantId,
      property_id: row.propertyId ?? null,
      location_id: row.locationId ?? null,
      destination_location_id: row.destinationLocationId ?? null,
      inventory_item_id: row.inventoryItemId,
      unit_id: row.unitId ?? null,
      movement_type: row.movementType,
      quantity: row.quantity,
      unit_cost: row.unitCost,
      total_cost: Math.abs(row.quantity) * row.unitCost,
      currency: row.currency,
      reason: row.reason ?? null,
      notes: row.notes ?? null,
      reference_type: row.referenceType ?? null,
      reference_id: row.referenceId ?? null,
      order_item_id: row.orderItemId ?? null,
      transfer_id: row.transferId ?? null,
      transfer_line_id: row.transferLineId ?? null,
      stocktake_id: row.stocktakeId ?? null,
      production_id: row.productionId ?? null,
      batch_id: row.batchId ?? null,
      reversal_of_id: row.reversalOfId ?? null,
      correlation_id: row.correlationId ?? null,
      reason_code: row.reasonCode ?? null,
      approved_by: row.approvedBy ?? null,
      approved_at: row.approvedBy ? new Date().toISOString() : null,
      occurred_at: row.occurredAt ?? new Date().toISOString(),
      dedupe_key: row.dedupeKey ?? null,
      created_by: userId,
    })
    .select("id, quantity, unit_cost, total_cost, balance_after, movement_type, inventory_item_id, location_id")
    .single();
  if (error) {
    // Idempotency: the same fact must never move stock twice.
    if (String(error.code) === "23505") return null;
    throw new Error(error.message);
  }
  return data;
}

export async function recordMovement(sb: Sb, userId: string, input: RecordMovementInput) {
  await assertCapability(sb, userId, input.tenantId, "stock.manage");

  const { data: item, error: itemErr } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, average_cost, currency, reorder_point, unit_id, location_id, property_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.inventoryItemId)
    .single();
  if (itemErr || !item) throw new Error("Inventory item not found.");

  const unitCost = input.unitCost ?? Number(item.average_cost ?? 0);
  const quantity = signedQuantity(input.movementType, input.quantity);

  const moved = await insertMovement(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? item.property_id,
    locationId: input.locationId ?? item.location_id,
    inventoryItemId: input.inventoryItemId,
    unitId: input.unitId ?? item.unit_id,
    movementType: input.movementType,
    quantity,
    unitCost,
    currency: input.currency ?? item.currency ?? "TZS",
    reason: input.reason,
    notes: input.notes,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    occurredAt: input.occurredAt,
    dedupeKey: input.dedupeKey,
  });
  if (!moved) return { duplicate: true as const };

  await emitRestaurantEvent(sb, userId, {
    type: input.movementType === "wastage" ? "restaurant.waste.recorded" : "restaurant.stock.moved",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId ?? undefined,
    entityType: "restaurant_inventory_item",
    entityId: input.inventoryItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      movement_type: input.movementType,
      quantity: Number(moved.quantity),
      cost: Number(moved.total_cost),
      balance_after: Number(moved.balance_after ?? 0),
      reason: input.reason ?? null,
    },
  });

  if (item.reorder_point != null && Number(moved.balance_after ?? 0) <= Number(item.reorder_point)) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.low",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.locationId ?? undefined,
      entityType: "restaurant_inventory_item",
      entityId: input.inventoryItemId,
      source: "restaurant-os",
      payload: {
        name: item.name,
        quantity: Number(moved.balance_after ?? 0),
        reorder_point: Number(item.reorder_point),
      },
    });
  }
  return { duplicate: false as const, movement: moved };
}

/** A transfer is two ledger entries so both outlets keep an auditable history. */
export async function transferStock(sb: Sb, userId: string, input: TransferStockInput) {
  await assertCapability(sb, userId, input.tenantId, "stock.manage");
  const { data: item } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, average_cost, currency, unit_id, location_id, property_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.inventoryItemId)
    .single();
  if (!item) throw new Error("Inventory item not found.");

  const unitCost = Number(item.average_cost ?? 0);
  const base = {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? item.property_id,
    inventoryItemId: input.inventoryItemId,
    unitId: input.unitId ?? item.unit_id,
    unitCost,
    currency: item.currency ?? "TZS",
    reason: input.reason ?? "Internal transfer",
    referenceType: "restaurant_transfer",
  };
  const stamp = new Date().toISOString();

  const out = await insertMovement(sb, userId, {
    ...base,
    locationId: input.locationId ?? item.location_id,
    destinationLocationId: input.destinationLocationId,
    movementType: "transfer_out",
    quantity: -Math.abs(input.quantity),
    occurredAt: stamp,
  });
  const inb = await insertMovement(sb, userId, {
    ...base,
    locationId: input.destinationLocationId,
    movementType: "transfer_in",
    quantity: Math.abs(input.quantity),
    occurredAt: stamp,
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.stock.transferred",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId ?? undefined,
    entityType: "restaurant_inventory_item",
    entityId: input.inventoryItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      quantity: Math.abs(input.quantity),
      to_location_id: input.destinationLocationId,
      cost: Math.abs(input.quantity) * unitCost,
    },
  });
  return { out, in: inb };
}

/**
 * Recipe-driven consumption — the seam between sales and stock.
 * Depletes every mapped ingredient for an order item and returns actual cost.
 */
export async function consumeForOrderItem(
  sb: Sb,
  userId: string,
  args: {
    tenantId: string;
    propertyId?: string | null;
    locationId?: string | null;
    orderId: string;
    orderItemId: string;
    menuItemId: string | null;
    quantity: number;
    occurredAt?: string;
  },
): Promise<number> {
  if (!args.menuItemId) return 0;

  const { data: components } = await sb
    .from("restaurant_recipe_components")
    .select("id, inventory_item_id, unit_id, quantity, yield_percent")
    .eq("tenant_id", args.tenantId)
    .eq("menu_item_id", args.menuItemId);

  const rows = ((components ?? []) as any[]).filter((c) => c.inventory_item_id);
  if (rows.length === 0) return 0;

  const { data: inv } = await sb
    .from("restaurant_inventory_items")
    .select("id, average_cost, currency, location_id, property_id")
    .in("id", rows.map((c) => c.inventory_item_id));
  const costs = new Map<string, any>(((inv ?? []) as any[]).map((r) => [r.id, r]));

  let actualCost = 0;
  for (const c of rows) {
    const meta = costs.get(c.inventory_item_id);
    const unitCost = Number(meta?.average_cost ?? 0);
    const perServing = Number(c.quantity) / (Number(c.yield_percent ?? 100) / 100);
    const consumed = perServing * args.quantity;
    if (consumed <= 0) continue;

    const moved = await insertMovement(sb, userId, {
      tenantId: args.tenantId,
      propertyId: args.propertyId ?? meta?.property_id ?? null,
      locationId: args.locationId ?? meta?.location_id ?? null,
      inventoryItemId: c.inventory_item_id,
      unitId: c.unit_id ?? null,
      movementType: "consumption",
      quantity: -consumed,
      unitCost,
      currency: meta?.currency ?? "TZS",
      reason: "Sales consumption",
      referenceType: "restaurant_order",
      referenceId: args.orderId,
      orderItemId: args.orderItemId,
      occurredAt: args.occurredAt,
      dedupeKey: `consume:${args.orderItemId}:${c.id}`,
    });
    // Duplicate (already consumed) still contributes to the recorded cost figure.
    actualCost += consumed * unitCost;
    if (!moved) continue;
  }
  return Number(actualCost.toFixed(4));
}
