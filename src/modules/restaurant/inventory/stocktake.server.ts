/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Stocktake: Session → Count → Review → Variance → Approval → Adjustment.
 *
 * A count never overwrites a balance. Approving a stocktake posts one
 * adjustment movement per varying line, so the ledger remains the only path
 * by which stock can change and every correction keeps its reason and actor.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "./movements.server";
import { locationNameMap } from "./locations.server";
import type { SaveStocktakeCountsInput, StartStocktakeInput, listStocktakesSchema } from "./contracts";

type Sb = any;

async function nextStocktakeNumber(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "stocktake",
    _prefix: "STK",
  });
  if (error || !data) return `STK-${Date.now()}`;
  return data as string;
}

export async function listStocktakes(sb: Sb, userId: string, input: z.infer<typeof listStocktakesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_stocktakes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const locations = await locationNameMap(sb, input.tenantId);
  return ((data ?? []) as any[]).map((s) => ({
    ...s,
    location_name: s.location_id ? (locations.get(s.location_id) ?? "Unknown") : "All locations",
  }));
}

export async function getStocktake(sb: Sb, userId: string, tenantId: string, stocktakeId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data: head, error } = await sb
    .from("restaurant_stocktakes")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", stocktakeId)
    .single();
  if (error || !head) throw new Error("Stocktake not found.");
  const [{ data: lines }, { data: items }, locations] = await Promise.all([
    sb.from("restaurant_stocktake_lines").select("*").eq("tenant_id", tenantId).eq("stocktake_id", stocktakeId),
    sb.from("restaurant_inventory_items").select("id, name, sku").eq("tenant_id", tenantId),
    locationNameMap(sb, tenantId),
  ]);
  const names = new Map(((items ?? []) as any[]).map((i) => [i.id, i.name]));
  return {
    ...head,
    location_name: head.location_id ? (locations.get(head.location_id) ?? "Unknown") : "All locations",
    lines: ((lines ?? []) as any[])
      .map((l) => ({
        ...l,
        item_name: names.get(l.inventory_item_id) ?? "Item",
        location_name: l.location_id ? (locations.get(l.location_id) ?? "Unknown") : "Unassigned",
      }))
      .sort((a, b) => String(a.item_name).localeCompare(String(b.item_name))),
  };
}

/** Snapshot expected quantities from the ledger at the moment counting starts. */
export async function startStocktake(sb: Sb, userId: string, input: StartStocktakeInput) {
  await assertCapability(sb, userId, input.tenantId, "stocktake.manage");

  let itemQuery = sb
    .from("restaurant_inventory_items")
    .select("id, name, category_id, unit_id, average_cost, current_quantity, location_id, currency")
    .eq("tenant_id", input.tenantId)
    .eq("status", "active");
  if (input.scope === "category" && input.categoryId) itemQuery = itemQuery.eq("category_id", input.categoryId);
  if (input.scope === "selected") {
    if (input.itemIds.length === 0) throw new Error("Select at least one item for a selected-item stocktake.");
    itemQuery = itemQuery.in("id", input.itemIds);
  }
  const { data: items, error: itemErr } = await itemQuery;
  if (itemErr) throw new Error(itemErr.message);

  // Expected quantity is read from the derived position view, per location.
  const { data: positions } = await sb
    .from("restaurant_stock_positions_v")
    .select("inventory_item_id, location_id, on_hand")
    .eq("tenant_id", input.tenantId);

  const number = await nextStocktakeNumber(sb, input.tenantId);
  const now = new Date().toISOString();
  const { data: head, error } = await sb
    .from("restaurant_stocktakes")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      category_id: input.categoryId ?? null,
      stocktake_number: number,
      scope: input.scope,
      status: "counting",
      counted_by: userId,
      started_at: now,
      notes: input.notes ?? null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const rows = ((items ?? []) as any[]).map((item) => {
    const slices = ((positions ?? []) as any[]).filter(
      (p) =>
        p.inventory_item_id === item.id &&
        (!input.locationId || p.location_id === input.locationId),
    );
    const expected = input.locationId
      ? slices.reduce((s, p) => s + Number(p.on_hand ?? 0), 0)
      : Number(item.current_quantity ?? 0);
    return {
      tenant_id: input.tenantId,
      stocktake_id: head.id,
      inventory_item_id: item.id,
      location_id: input.locationId ?? item.location_id ?? null,
      unit_id: item.unit_id ?? null,
      expected_quantity: expected,
      unit_cost: Number(item.average_cost ?? 0),
    };
  });
  if (rows.length > 0) {
    const { error: lineErr } = await sb.from("restaurant_stocktake_lines").insert(rows);
    if (lineErr) throw new Error(lineErr.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.stocktake.started",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId ?? undefined,
    entityType: "restaurant_stocktake",
    entityId: head.id,
    source: "restaurant-os",
    payload: { stocktake_number: number, scope: input.scope, lines: rows.length },
    dedupeKey: `stocktake:started:${head.id}`,
  });
  return { id: head.id as string, stocktakeNumber: number, lines: rows.length };
}

export async function saveStocktakeCounts(sb: Sb, userId: string, input: SaveStocktakeCountsInput) {
  await assertCapability(sb, userId, input.tenantId, "stocktake.manage");
  const { data: head } = await sb
    .from("restaurant_stocktakes")
    .select("id, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.stocktakeId)
    .single();
  if (!head) throw new Error("Stocktake not found.");
  if (!["draft", "counting", "review"].includes(head.status)) {
    throw new Error(`Counts cannot be edited once the stocktake is "${head.status}".`);
  }

  const now = new Date().toISOString();
  for (const l of input.lines) {
    const { error } = await sb
      .from("restaurant_stocktake_lines")
      .update({
        counted_quantity: l.countedQuantity,
        reason_code: l.reasonCode ?? null,
        notes: l.notes ?? null,
        counted_at: now,
      })
      .eq("id", l.lineId)
      .eq("tenant_id", input.tenantId)
      .eq("stocktake_id", input.stocktakeId);
    if (error) throw new Error(error.message);
  }

  if (input.submitForReview) {
    const { data: lines } = await sb
      .from("restaurant_stocktake_lines")
      .select("variance_quantity, unit_cost")
      .eq("tenant_id", input.tenantId)
      .eq("stocktake_id", input.stocktakeId);
    const varianceValue = ((lines ?? []) as any[]).reduce(
      (s, l) => s + Math.abs(Number(l.variance_quantity ?? 0)) * Number(l.unit_cost ?? 0),
      0,
    );
    await sb
      .from("restaurant_stocktakes")
      .update({ status: "review", counted_at: now, variance_value: Number(varianceValue.toFixed(2)) })
      .eq("id", input.stocktakeId)
      .eq("tenant_id", input.tenantId);
  }
  return { saved: input.lines.length, status: input.submitForReview ? "review" : "counting" };
}

/**
 * Approve and post. Every varying line becomes an adjustment movement — the
 * stocktake itself never writes a balance.
 */
export async function postStocktake(
  sb: Sb,
  userId: string,
  input: { tenantId: string; stocktakeId: string; approve: boolean; reason?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "stocktake.approve");
  const { data: head } = await sb
    .from("restaurant_stocktakes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.stocktakeId)
    .single();
  if (!head) throw new Error("Stocktake not found.");
  if (!input.approve) {
    await sb
      .from("restaurant_stocktakes")
      .update({ status: "cancelled", notes: input.reason ?? head.notes })
      .eq("id", input.stocktakeId)
      .eq("tenant_id", input.tenantId);
    return { status: "cancelled" as const, posted: 0, varianceValue: 0 };
  }
  if (!["review", "approved", "counting"].includes(head.status)) {
    throw new Error(`Stocktake cannot be posted from status "${head.status}".`);
  }

  const { data: lines } = await sb
    .from("restaurant_stocktake_lines")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("stocktake_id", input.stocktakeId);

  const now = new Date().toISOString();
  let posted = 0;
  let varianceValue = 0;

  for (const line of ((lines ?? []) as any[])) {
    if (line.counted_quantity == null) continue;
    const variance = Number(line.variance_quantity ?? 0);
    if (Math.abs(variance) < 1e-9) continue;

    const moved = await insertMovement(sb, userId, {
      tenantId: input.tenantId,
      propertyId: head.property_id,
      locationId: line.location_id,
      inventoryItemId: line.inventory_item_id,
      unitId: line.unit_id,
      movementType: variance > 0 ? "adjustment_in" : "adjustment_out",
      quantity: variance,
      unitCost: Number(line.unit_cost ?? 0),
      currency: head.currency ?? "TZS",
      reason: `Stocktake ${head.stocktake_number}`,
      reasonCode: line.reason_code ?? "counting_error",
      notes: line.notes,
      referenceType: "restaurant_stocktake",
      referenceId: head.id,
      stocktakeId: head.id,
      correlationId: head.id,
      approvedBy: userId,
      occurredAt: now,
      dedupeKey: `stocktake:${line.id}`,
    });
    varianceValue += Math.abs(variance) * Number(line.unit_cost ?? 0);
    if (moved) {
      posted += 1;
      await sb
        .from("restaurant_stocktake_lines")
        .update({ posted_movement_id: moved.id })
        .eq("id", line.id)
        .eq("tenant_id", input.tenantId);
    }
  }

  await sb
    .from("restaurant_stocktakes")
    .update({
      status: "posted",
      approved_by: userId,
      approved_at: now,
      posted_at: now,
      variance_value: Number(varianceValue.toFixed(2)),
    })
    .eq("id", input.stocktakeId)
    .eq("tenant_id", input.tenantId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.stocktake.completed",
    tenantId: input.tenantId,
    propertyId: head.property_id ?? undefined,
    locationId: head.location_id ?? undefined,
    entityType: "restaurant_stocktake",
    entityId: head.id,
    source: "restaurant-os",
    payload: {
      stocktake_number: head.stocktake_number,
      adjustments: posted,
      variance_value: Number(varianceValue.toFixed(2)),
    },
    dedupeKey: `stocktake:completed:${head.id}`,
  });

  // Bar mirror when the counted location is a bar service point.
  if (head.location_id) {
    const { data: loc } = await sb
      .from("restaurant_locations")
      .select("location_type, name")
      .eq("tenant_id", input.tenantId)
      .eq("id", head.location_id)
      .maybeSingle();
    if (loc?.location_type === "bar") {
      await emitRestaurantEvent(sb, userId, {
        type: "bar.stocktake.completed",
        tenantId: input.tenantId,
        propertyId: head.property_id ?? undefined,
        locationId: head.location_id,
        entityType: "restaurant_stocktake",
        entityId: head.id,
        source: "restaurant-os",
        payload: {
          stocktake_number: head.stocktake_number,
          location_name: loc.name,
          adjustments: posted,
          variance_value: Number(varianceValue.toFixed(2)),
        },
        dedupeKey: `bar:stocktake:completed:${head.id}`,
      });
    }
  }

  if (varianceValue > 0) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.variance.detected",
      tenantId: input.tenantId,
      propertyId: head.property_id ?? undefined,
      locationId: head.location_id ?? undefined,
      entityType: "restaurant_stocktake",
      entityId: head.id,
      source: "restaurant-os",
      payload: {
        kind: "stocktake",
        stocktake_number: head.stocktake_number,
        variance_value: Number(varianceValue.toFixed(2)),
      },
      dedupeKey: `stocktake:variance:${head.id}`,
    });
  }
  return { status: "posted" as const, posted, varianceValue: Number(varianceValue.toFixed(2)) };
}