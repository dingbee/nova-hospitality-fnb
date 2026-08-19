/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Multi-location transfers.
 *
 * A transfer is a *document*, not an adjustment. Dispatch is not receipt:
 * stock leaves the source when it is dispatched and only enters the
 * destination when someone confirms what actually arrived. Both ledger
 * entries carry the transfer id, so the pair is always reconcilable and the
 * gap between them (variance) is visible rather than silently absorbed.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "./movements.server";
import { assertLocationInTenant, locationNameMap } from "./locations.server";
import type {
  CreateTransferInput,
  DispatchTransferInput,
  ReceiveTransferInput,
  listTransfersSchema,
} from "./contracts";

type Sb = any;

async function nextTransferNumber(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "transfer",
    _prefix: "TRF",
  });
  if (error || !data) return `TRF-${Date.now()}`;
  return data as string;
}

async function loadTransfer(sb: Sb, tenantId: string, transferId: string) {
  const { data, error } = await sb
    .from("restaurant_stock_transfers")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", transferId)
    .single();
  if (error || !data) throw new Error("Transfer not found.");
  const { data: lines } = await sb
    .from("restaurant_stock_transfer_lines")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("transfer_id", transferId);
  return { transfer: data as any, lines: ((lines ?? []) as any[]) };
}

export async function listTransfers(sb: Sb, userId: string, input: z.infer<typeof listTransfersSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_stock_transfers")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as any[];
  if (input.locationId) {
    rows = rows.filter(
      (t) => t.source_location_id === input.locationId || t.destination_location_id === input.locationId,
    );
  }
  const ids = rows.map((r) => r.id);
  const [{ data: lines }, locations] = await Promise.all([
    ids.length
      ? sb.from("restaurant_stock_transfer_lines").select("*").in("transfer_id", ids)
      : Promise.resolve({ data: [] }),
    locationNameMap(sb, input.tenantId),
  ]);
  return rows.map((t) => ({
    ...t,
    source_name: locations.get(t.source_location_id) ?? "—",
    destination_name: locations.get(t.destination_location_id) ?? "—",
    lines: ((lines ?? []) as any[]).filter((l) => l.transfer_id === t.id),
  }));
}

export async function getTransfer(sb: Sb, userId: string, tenantId: string, transferId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { transfer, lines } = await loadTransfer(sb, tenantId, transferId);
  const locations = await locationNameMap(sb, tenantId);
  return {
    ...transfer,
    source_name: locations.get(transfer.source_location_id) ?? "—",
    destination_name: locations.get(transfer.destination_location_id) ?? "—",
    lines,
  };
}

export async function createTransfer(sb: Sb, userId: string, input: CreateTransferInput) {
  await assertCapability(sb, userId, input.tenantId, "transfer.manage");
  if (input.sourceLocationId === input.destinationLocationId) {
    throw new Error("Source and destination must be different locations.");
  }
  await assertLocationInTenant(sb, input.tenantId, input.sourceLocationId, input.destinationLocationId);

  const { data: items } = await sb
    .from("restaurant_inventory_items")
    .select("id, average_cost, currency, unit_id")
    .eq("tenant_id", input.tenantId)
    .in("id", input.lines.map((l) => l.inventoryItemId));
  const meta = new Map(((items ?? []) as any[]).map((i) => [i.id, i]));
  if (meta.size !== new Set(input.lines.map((l) => l.inventoryItemId)).size) {
    throw new Error("One or more inventory items do not belong to this tenant.");
  }

  const number = await nextTransferNumber(sb, input.tenantId);
  const now = new Date().toISOString();
  const submitted = input.submit;
  const totalValue = input.lines.reduce(
    (s, l) => s + l.requestedQuantity * Number(meta.get(l.inventoryItemId)?.average_cost ?? 0),
    0,
  );

  const { data: transfer, error } = await sb
    .from("restaurant_stock_transfers")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      transfer_number: number,
      source_location_id: input.sourceLocationId,
      destination_location_id: input.destinationLocationId,
      status: submitted ? (input.requiresApproval ? "requested" : "approved") : "draft",
      requires_approval: input.requiresApproval,
      requested_by: userId,
      requested_at: submitted ? now : null,
      approved_by: submitted && !input.requiresApproval ? userId : null,
      approved_at: submitted && !input.requiresApproval ? now : null,
      notes: input.notes ?? null,
      total_value: Number(totalValue.toFixed(2)),
      currency: (meta.values().next().value as any)?.currency ?? "TZS",
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const { error: lineErr } = await sb.from("restaurant_stock_transfer_lines").insert(
    input.lines.map((l) => ({
      tenant_id: input.tenantId,
      transfer_id: transfer.id,
      inventory_item_id: l.inventoryItemId,
      unit_id: l.unitId ?? meta.get(l.inventoryItemId)?.unit_id ?? null,
      batch_id: l.batchId ?? null,
      requested_quantity: l.requestedQuantity,
      unit_cost: Number(meta.get(l.inventoryItemId)?.average_cost ?? 0),
      notes: l.notes ?? null,
    })),
  );
  if (lineErr) throw new Error(lineErr.message);

  if (submitted) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.transfer.requested",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.sourceLocationId,
      entityType: "restaurant_stock_transfer",
      entityId: transfer.id,
      source: "restaurant-os",
      payload: {
        transfer_number: number,
        lines: input.lines.length,
        to_location_id: input.destinationLocationId,
        value: Number(totalValue.toFixed(2)),
      },
      dedupeKey: `transfer:requested:${transfer.id}`,
    });
  }
  return { id: transfer.id as string, transferNumber: number, status: transfer.status as string };
}

export async function approveTransfer(
  sb: Sb,
  userId: string,
  input: { tenantId: string; transferId: string; approve: boolean; reason?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "transfer.approve");
  const { transfer } = await loadTransfer(sb, input.tenantId, input.transferId);
  if (!["draft", "requested"].includes(transfer.status)) {
    throw new Error(`Transfer cannot be approved from status "${transfer.status}".`);
  }
  const now = new Date().toISOString();
  const { error } = await sb
    .from("restaurant_stock_transfers")
    .update({
      status: input.approve ? "approved" : "rejected",
      approved_by: userId,
      approved_at: now,
      rejection_reason: input.approve ? null : (input.reason ?? "Rejected"),
    })
    .eq("id", input.transferId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: input.approve ? "restaurant.inventory.transfer.approved" : "restaurant.inventory.transfer.rejected",
    tenantId: input.tenantId,
    propertyId: transfer.property_id ?? undefined,
    locationId: transfer.source_location_id,
    entityType: "restaurant_stock_transfer",
    entityId: input.transferId,
    source: "restaurant-os",
    payload: { transfer_number: transfer.transfer_number, reason: input.reason ?? null },
    dedupeKey: `transfer:${input.approve ? "approved" : "rejected"}:${input.transferId}`,
  });
  return { status: input.approve ? "approved" : "rejected" };
}

/** Dispatch: stock leaves the source location. Nothing arrives yet. */
export async function dispatchTransfer(sb: Sb, userId: string, input: DispatchTransferInput) {
  await assertCapability(sb, userId, input.tenantId, "transfer.manage");
  const { transfer, lines } = await loadTransfer(sb, input.tenantId, input.transferId);
  if (!["approved", "requested"].includes(transfer.status)) {
    throw new Error(`Transfer cannot be dispatched from status "${transfer.status}".`);
  }
  if (transfer.requires_approval && transfer.status !== "approved") {
    throw new Error("This transfer requires approval before dispatch.");
  }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const stamp = new Date().toISOString();
  let dispatchedValue = 0;

  for (const l of input.lines) {
    const line = byId.get(l.lineId);
    if (!line) throw new Error("Transfer line not found.");
    if (l.dispatchedQuantity <= 0) continue;
    if (l.dispatchedQuantity > Number(line.requested_quantity)) {
      throw new Error("Dispatched quantity cannot exceed the requested quantity.");
    }
    await insertMovement(sb, userId, {
      tenantId: input.tenantId,
      propertyId: transfer.property_id,
      locationId: transfer.source_location_id,
      destinationLocationId: transfer.destination_location_id,
      inventoryItemId: line.inventory_item_id,
      unitId: line.unit_id,
      movementType: "transfer_out",
      quantity: -Math.abs(l.dispatchedQuantity),
      unitCost: Number(line.unit_cost ?? 0),
      currency: transfer.currency ?? "TZS",
      reason: "Transfer dispatch",
      referenceType: "restaurant_stock_transfer",
      referenceId: transfer.id,
      transferId: transfer.id,
      transferLineId: line.id,
      correlationId: transfer.id,
      batchId: line.batch_id,
      occurredAt: stamp,
      dedupeKey: `transfer:out:${line.id}`,
    });
    dispatchedValue += l.dispatchedQuantity * Number(line.unit_cost ?? 0);
    await sb
      .from("restaurant_stock_transfer_lines")
      .update({ dispatched_quantity: l.dispatchedQuantity })
      .eq("id", line.id)
      .eq("tenant_id", input.tenantId);
  }

  const { error } = await sb
    .from("restaurant_stock_transfers")
    .update({
      status: "dispatched",
      dispatched_by: userId,
      dispatched_at: stamp,
      notes: input.notes ?? transfer.notes,
    })
    .eq("id", input.transferId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.transfer.dispatched",
    tenantId: input.tenantId,
    propertyId: transfer.property_id ?? undefined,
    locationId: transfer.source_location_id,
    entityType: "restaurant_stock_transfer",
    entityId: transfer.id,
    source: "restaurant-os",
    payload: {
      transfer_number: transfer.transfer_number,
      to_location_id: transfer.destination_location_id,
      value: Number(dispatchedValue.toFixed(2)),
    },
    dedupeKey: `transfer:dispatched:${transfer.id}`,
  });
  return { status: "dispatched" as const };
}

/** Receipt: only what actually arrived enters the destination location. */
export async function receiveTransfer(sb: Sb, userId: string, input: ReceiveTransferInput) {
  await assertCapability(sb, userId, input.tenantId, "transfer.manage");
  const { transfer, lines } = await loadTransfer(sb, input.tenantId, input.transferId);
  if (!["dispatched", "partially_received"].includes(transfer.status)) {
    throw new Error(`Transfer cannot be received from status "${transfer.status}".`);
  }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const stamp = new Date().toISOString();
  let variance = 0;
  let fullyReceived = true;

  for (const l of input.lines) {
    const line = byId.get(l.lineId);
    if (!line) throw new Error("Transfer line not found.");
    const dispatched = Number(line.dispatched_quantity ?? 0);
    const total = l.receivedQuantity + l.rejectedQuantity + l.damagedQuantity;
    if (total > dispatched + 1e-9) {
      throw new Error("Received, rejected and damaged quantities cannot exceed the dispatched quantity.");
    }
    if (l.receivedQuantity > 0) {
      await insertMovement(sb, userId, {
        tenantId: input.tenantId,
        propertyId: transfer.property_id,
        locationId: transfer.destination_location_id,
        inventoryItemId: line.inventory_item_id,
        unitId: line.unit_id,
        movementType: "transfer_in",
        quantity: Math.abs(l.receivedQuantity),
        unitCost: Number(line.unit_cost ?? 0),
        currency: transfer.currency ?? "TZS",
        reason: "Transfer receipt",
        referenceType: "restaurant_stock_transfer",
        referenceId: transfer.id,
        transferId: transfer.id,
        transferLineId: line.id,
        correlationId: transfer.id,
        batchId: line.batch_id,
        occurredAt: stamp,
        dedupeKey: `transfer:in:${line.id}`,
      });
    }
    const lineVariance = dispatched - total;
    variance += Math.abs(lineVariance) * Number(line.unit_cost ?? 0);
    if (total < dispatched - 1e-9) fullyReceived = false;

    await sb
      .from("restaurant_stock_transfer_lines")
      .update({
        received_quantity: l.receivedQuantity,
        rejected_quantity: l.rejectedQuantity,
        damaged_quantity: l.damagedQuantity,
        notes: l.notes ?? line.notes,
      })
      .eq("id", line.id)
      .eq("tenant_id", input.tenantId);
  }

  const status = fullyReceived ? "completed" : "partially_received";
  const { error } = await sb
    .from("restaurant_stock_transfers")
    .update({
      status,
      received_by: userId,
      received_at: stamp,
      completed_at: fullyReceived ? stamp : null,
      notes: input.notes ?? transfer.notes,
    })
    .eq("id", input.transferId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.transfer.received",
    tenantId: input.tenantId,
    propertyId: transfer.property_id ?? undefined,
    locationId: transfer.destination_location_id,
    entityType: "restaurant_stock_transfer",
    entityId: transfer.id,
    source: "restaurant-os",
    payload: {
      transfer_number: transfer.transfer_number,
      status,
      variance_value: Number(variance.toFixed(2)),
    },
    dedupeKey: `transfer:received:${transfer.id}:${status}`,
  });

  // Bar mirror when the receiving location is a bar service point.
  if (status === "completed") {
    const { data: destination } = await sb
      .from("restaurant_locations")
      .select("location_type")
      .eq("tenant_id", input.tenantId)
      .eq("id", transfer.destination_location_id)
      .maybeSingle();
    if (destination?.location_type === "bar") {
      await emitRestaurantEvent(sb, userId, {
        type: "bar.transfer.completed",
        tenantId: input.tenantId,
        propertyId: transfer.property_id ?? undefined,
        locationId: transfer.destination_location_id,
        entityType: "restaurant_stock_transfer",
        entityId: transfer.id,
        source: "restaurant-os",
        payload: { transfer_number: transfer.transfer_number, status },
        dedupeKey: `bar:transfer:completed:${transfer.id}:${status}`,
      });
    }
  }

  if (variance > 0) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.variance.detected",
      tenantId: input.tenantId,
      propertyId: transfer.property_id ?? undefined,
      locationId: transfer.destination_location_id,
      entityType: "restaurant_stock_transfer",
      entityId: transfer.id,
      source: "restaurant-os",
      payload: {
        kind: "transfer",
        transfer_number: transfer.transfer_number,
        variance_value: Number(variance.toFixed(2)),
      },
      dedupeKey: `transfer:variance:${transfer.id}`,
    });
  }
  return { status, varianceValue: Number(variance.toFixed(2)) };
}

export async function cancelTransfer(
  sb: Sb,
  userId: string,
  input: { tenantId: string; transferId: string; reason?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "transfer.manage");
  const { transfer } = await loadTransfer(sb, input.tenantId, input.transferId);
  if (["dispatched", "partially_received", "received", "completed"].includes(transfer.status)) {
    throw new Error("A dispatched transfer cannot be cancelled — reverse the movements instead.");
  }
  const { error } = await sb
    .from("restaurant_stock_transfers")
    .update({ status: "cancelled", rejection_reason: input.reason ?? "Cancelled" })
    .eq("id", input.transferId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { status: "cancelled" as const };
}