/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Waste, adjustments and reversals — the three ways stock changes without a
 * sale or a delivery. All three post through the ledger and all three demand a
 * reason: an unexplained balance change is not permitted anywhere in this module.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "./movements.server";
import { assertLocationInTenant } from "./locations.server";
import {
  DEFAULT_ADJUSTMENT_REASONS,
  DEFAULT_WASTE_REASONS,
  type RecordAdjustmentInput,
  type RecordWasteInput,
  type UpsertReasonInput,
  type listReasonsSchema,
} from "./contracts";

type Sb = any;

interface ReasonRow {
  id: string | null;
  kind: string;
  code: string;
  label: string;
  requires_approval: boolean;
  requires_note: boolean;
  active: boolean;
  builtin: boolean;
}

function builtins(kind?: string): ReasonRow[] {
  const map: Array<[string, readonly { code: string; label: string }[]]> = [
    ["waste", DEFAULT_WASTE_REASONS],
    ["adjustment", DEFAULT_ADJUSTMENT_REASONS],
  ];
  return map
    .filter(([k]) => !kind || k === kind)
    .flatMap(([k, list]) =>
      list.map((r) => ({
        id: null,
        kind: k,
        code: r.code,
        label: r.label,
        requires_approval: false,
        requires_note: r.code === "unknown" || r.code === "correction",
        active: true,
        builtin: true,
      })),
    );
}

/**
 * Tenant-configured reasons win; the hospitality defaults fill the gaps so a
 * new tenant is usable on day one without hard-coding anyone's catalogue.
 */
export async function listReasons(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listReasonsSchema>,
): Promise<ReasonRow[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_inventory_reasons")
    .select("id, kind, code, label, requires_approval, requires_note, active, sort_order")
    .eq("tenant_id", input.tenantId)
    .order("sort_order");
  if (input.kind) q = q.eq("kind", input.kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const configured = ((data ?? []) as any[]).map((r) => ({ ...r, builtin: false })) as ReasonRow[];
  const seen = new Set(configured.map((r) => `${r.kind}:${r.code}`));
  return [...configured, ...builtins(input.kind).filter((b) => !seen.has(`${b.kind}:${b.code}`))].filter(
    (r) => r.active,
  );
}

export async function upsertReason(sb: Sb, userId: string, input: UpsertReasonInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const row = {
    tenant_id: input.tenantId,
    kind: input.kind,
    code: input.code,
    label: input.label,
    requires_approval: input.requiresApproval,
    requires_note: input.requiresNote,
    active: input.active,
    sort_order: input.sortOrder,
  };
  const q = input.id
    ? sb.from("restaurant_inventory_reasons").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_reasons").upsert(row, { onConflict: "tenant_id,kind,code" });
  const { data, error } = await q.select("id, kind, code, label, active").single();
  if (error) throw new Error(error.message);
  return data;
}

async function resolveReason(sb: Sb, userId: string, tenantId: string, kind: string, code: string) {
  const reasons = await listReasons(sb, userId, { tenantId, kind } as z.infer<typeof listReasonsSchema>);
  const found = reasons.find((r) => r.code === code);
  if (!found) throw new Error(`Unknown ${kind} reason "${code}".`);
  return found;
}

async function itemMeta(sb: Sb, tenantId: string, itemId: string) {
  const { data, error } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, average_cost, currency, unit_id, location_id, property_id, reorder_point, allow_negative, current_quantity, is_beverage, item_type")
    .eq("tenant_id", tenantId)
    .eq("id", itemId)
    .single();
  if (error || !data) throw new Error("Inventory item not found.");
  return data as any;
}

export async function recordWaste(sb: Sb, userId: string, input: RecordWasteInput) {
  await assertCapability(sb, userId, input.tenantId, "waste.record");
  await assertLocationInTenant(sb, input.tenantId, input.locationId);
  const item = await itemMeta(sb, input.tenantId, input.inventoryItemId);
  const reason = await resolveReason(sb, userId, input.tenantId, "waste", input.reasonCode);
  if (reason.requires_note && !input.notes) throw new Error(`Reason "${reason.label}" requires a note.`);

  const unitCost = Number(item.average_cost ?? 0);
  const locationId = input.locationId ?? item.location_id ?? null;
  const moved = await insertMovement(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? item.property_id,
    locationId,
    inventoryItemId: input.inventoryItemId,
    unitId: input.unitId ?? item.unit_id,
    movementType: "wastage",
    quantity: -Math.abs(input.quantity),
    unitCost,
    currency: item.currency ?? "TZS",
    reason: reason.label,
    reasonCode: reason.code,
    notes: input.notes,
    batchId: input.batchId,
    referenceType: "restaurant_waste",
    occurredAt: input.occurredAt,
    dedupeKey: input.dedupeKey,
  });
  if (!moved) return { duplicate: true as const };

  const value = Math.abs(input.quantity) * unitCost;
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.waste.recorded",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: locationId ?? undefined,
    entityType: "restaurant_inventory_item",
    entityId: input.inventoryItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      quantity: Math.abs(input.quantity),
      reason_code: reason.code,
      value: Number(value.toFixed(2)),
      balance_after: Number(moved.balance_after ?? 0),
    },
    dedupeKey: `waste:${moved.id}`,
  });
  // Bar mirror: same fact, beverage dimension, for the Intelligence Core.
  if (item.is_beverage || item.item_type === "beverage") {
    await emitRestaurantEvent(sb, userId, {
      type: "bar.waste.recorded",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: locationId ?? undefined,
      entityType: "restaurant_inventory_item",
      entityId: input.inventoryItemId,
      source: "restaurant-os",
      payload: {
        name: item.name,
        quantity: Math.abs(input.quantity),
        reason_code: reason.code,
        value: Number(value.toFixed(2)),
      },
      dedupeKey: `bar:waste:${moved.id}`,
    });
  }
  return { duplicate: false as const, movementId: moved.id as string, value: Number(value.toFixed(2)) };
}

export async function recordAdjustment(sb: Sb, userId: string, input: RecordAdjustmentInput) {
  await assertCapability(sb, userId, input.tenantId, "adjustment.manage");
  await assertLocationInTenant(sb, input.tenantId, input.locationId);
  const item = await itemMeta(sb, input.tenantId, input.inventoryItemId);
  const reason = await resolveReason(sb, userId, input.tenantId, "adjustment", input.reasonCode);
  if (reason.requires_note && !input.notes) throw new Error(`Reason "${reason.label}" requires a note.`);
  if (reason.requires_approval) {
    await assertCapability(sb, userId, input.tenantId, "stocktake.approve");
  }
  if (!item.allow_negative && Number(item.current_quantity ?? 0) + input.quantity < 0) {
    throw new Error("This item does not permit negative stock.");
  }

  const unitCost = Number(item.average_cost ?? 0);
  const locationId = input.locationId ?? item.location_id ?? null;
  const moved = await insertMovement(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? item.property_id,
    locationId,
    inventoryItemId: input.inventoryItemId,
    unitId: input.unitId ?? item.unit_id,
    movementType: input.quantity > 0 ? "adjustment_in" : "adjustment_out",
    quantity: input.quantity,
    unitCost,
    currency: item.currency ?? "TZS",
    reason: reason.label,
    reasonCode: reason.code,
    notes: input.notes,
    referenceType: input.referenceType ?? "restaurant_adjustment",
    referenceId: input.referenceId,
    approvedBy: reason.requires_approval ? userId : null,
    occurredAt: input.occurredAt,
    dedupeKey: input.dedupeKey,
  });
  if (!moved) return { duplicate: true as const };

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.adjustment.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: locationId ?? undefined,
    entityType: "restaurant_inventory_item",
    entityId: input.inventoryItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      quantity: input.quantity,
      reason_code: reason.code,
      value: Number((Math.abs(input.quantity) * unitCost).toFixed(2)),
      balance_after: Number(moved.balance_after ?? 0),
    },
    dedupeKey: `adjustment:${moved.id}`,
  });
  return { duplicate: false as const, movementId: moved.id as string };
}

/**
 * Reversal, not deletion. The original movement stays in the ledger; a mirror
 * entry cancels its effect and points back at it.
 */
export async function reverseMovement(
  sb: Sb,
  userId: string,
  input: { tenantId: string; movementId: string; reason: string },
) {
  await assertCapability(sb, userId, input.tenantId, "adjustment.manage");
  const { data: original, error } = await sb
    .from("restaurant_stock_movements")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.movementId)
    .single();
  if (error || !original) throw new Error("Movement not found.");
  if (original.movement_type === "reversal") throw new Error("A reversal cannot itself be reversed.");

  const moved = await insertMovement(sb, userId, {
    tenantId: input.tenantId,
    propertyId: original.property_id,
    locationId: original.location_id,
    inventoryItemId: original.inventory_item_id,
    unitId: original.unit_id,
    movementType: "reversal",
    quantity: -Number(original.quantity),
    unitCost: Number(original.unit_cost ?? 0),
    currency: original.currency ?? "TZS",
    reason: input.reason,
    reasonCode: "correction",
    referenceType: original.reference_type,
    referenceId: original.reference_id,
    reversalOfId: original.id,
    correlationId: original.correlation_id ?? original.id,
    approvedBy: userId,
    dedupeKey: `reversal:${original.id}`,
  });
  if (!moved) return { duplicate: true as const };

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.movement.reversed",
    tenantId: input.tenantId,
    propertyId: original.property_id ?? undefined,
    locationId: original.location_id ?? undefined,
    entityType: "restaurant_stock_movement",
    entityId: original.id,
    source: "restaurant-os",
    payload: { original_type: original.movement_type, quantity: -Number(original.quantity), reason: input.reason },
    dedupeKey: `reversal:${original.id}`,
  });
  return { duplicate: false as const, movementId: moved.id as string };
}