/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Kitchen / Bar / Department Requisitions (Sprint 5.5).
 *
 * A requisition is a document, not an adjustment: a department asks a store
 * for stock, a manager approves a quantity (which may differ from what was
 * asked), and a storekeeper issues it. Issuing always posts a transfer_out /
 * transfer_in pair through the ledger — the same primitive the Transfers
 * workflow uses — so a requisition can never silently move stock twice.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "../inventory/movements.server";
import { assertLocationInTenant, locationNameMap } from "../inventory/locations.server";
import {
  requisitionPrefix,
  type ApproveRequisitionInput,
  type IssueRequisitionInput,
  type SaveRequisitionDraftInput,
  type listRequisitionsSchema,
} from "./contracts";

type Sb = any;

async function nextRequisitionNumber(sb: Sb, tenantId: string, kind: string): Promise<string> {
  const prefix = requisitionPrefix(kind as any);
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "requisition",
    _prefix: prefix,
  });
  if (error || !data) return `${prefix}-${Date.now()}`;
  return data as string;
}

async function loadRequisition(sb: Sb, tenantId: string, requisitionId: string) {
  const { data, error } = await sb
    .from("restaurant_requisitions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", requisitionId)
    .single();
  if (error || !data) throw new Error("Requisition not found.");
  const { data: lines, error: lineErr } = await sb
    .from("restaurant_requisition_lines")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("requisition_id", requisitionId)
    .order("sort_order");
  if (lineErr) throw new Error(lineErr.message);
  return { requisition: data as any, lines: (lines ?? []) as any[] };
}

async function itemNameMap(sb: Sb, tenantId: string, ids: string[]): Promise<Map<string, any>> {
  if (ids.length === 0) return new Map();
  const { data } = await sb
    .from("restaurant_inventory_items")
    .select("id, name, average_cost, currency, unit_id, location_id, property_id")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  return new Map(((data ?? []) as any[]).map((i) => [i.id as string, i]));
}

function outstandingOf(line: any): number {
  return Math.max(0, Number(line.approved_quantity ?? line.requested_quantity ?? 0) - Number(line.issued_quantity ?? 0));
}

export async function listRequisitions(sb: Sb, userId: string, input: z.infer<typeof listRequisitionsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_requisitions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.status) q = q.eq("status", input.status);
  if (input.kind) q = q.eq("kind", input.kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  const ids = rows.map((r) => r.id);
  const [{ data: lines }, locations] = await Promise.all([
    ids.length
      ? sb.from("restaurant_requisition_lines").select("*").in("requisition_id", ids)
      : Promise.resolve({ data: [] }),
    locationNameMap(sb, input.tenantId),
  ]);
  return rows.map((r) => {
    const rLines = ((lines ?? []) as any[]).filter((l) => l.requisition_id === r.id);
    return {
      ...r,
      source_name: locations.get(r.source_location_id) ?? "—",
      destination_name: locations.get(r.destination_location_id) ?? "—",
      line_count: rLines.length,
      outstanding_lines: rLines.filter((l) => outstandingOf(l) > 0.0001).length,
    };
  });
}

export async function getRequisition(sb: Sb, userId: string, tenantId: string, requisitionId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { requisition, lines } = await loadRequisition(sb, tenantId, requisitionId);
  const locations = await locationNameMap(sb, tenantId);
  const items = await itemNameMap(sb, tenantId, lines.map((l) => l.inventory_item_id));
  return {
    ...requisition,
    source_name: locations.get(requisition.source_location_id) ?? "—",
    destination_name: locations.get(requisition.destination_location_id) ?? "—",
    lines: lines.map((l) => ({
      ...l,
      item_name: items.get(l.inventory_item_id)?.name ?? "Item",
      outstanding_quantity: outstandingOf(l),
    })),
  };
}

/** Create or update a requisition header + lines while it is still a draft. */
export async function saveRequisitionDraft(sb: Sb, userId: string, input: SaveRequisitionDraftInput) {
  await assertCapability(sb, userId, input.tenantId, "requisition.create");
  if (input.sourceLocationId === input.destinationLocationId) {
    throw new Error("Source store and destination must be different locations.");
  }
  await assertLocationInTenant(sb, input.tenantId, input.sourceLocationId, input.destinationLocationId);

  const items = await itemNameMap(sb, input.tenantId, input.lines.map((l) => l.inventoryItemId));
  if (items.size !== new Set(input.lines.map((l) => l.inventoryItemId)).size) {
    throw new Error("One or more inventory items do not belong to this tenant.");
  }

  let requisitionId = input.id;
  let reference: string;
  const now = new Date().toISOString();

  if (requisitionId) {
    const { requisition: existing } = await loadRequisition(sb, input.tenantId, requisitionId);
    if (existing.status !== "draft") {
      throw new Error(`Requisition cannot be edited from status "${existing.status}".`);
    }
    reference = existing.reference;
    const { error } = await sb
      .from("restaurant_requisitions")
      .update({
        kind: input.kind,
        department: input.department ?? null,
        source_location_id: input.sourceLocationId,
        destination_location_id: input.destinationLocationId,
        required_date: input.requiredDate ?? null,
        notes: input.notes ?? null,
        status: input.submit ? "submitted" : "draft",
        submitted_at: input.submit ? now : existing.submitted_at,
        updated_at: now,
      })
      .eq("id", requisitionId)
      .eq("tenant_id", input.tenantId);
    if (error) throw new Error(error.message);
    await sb.from("restaurant_requisition_lines").delete().eq("requisition_id", requisitionId).eq("tenant_id", input.tenantId);
  } else {
    reference = await nextRequisitionNumber(sb, input.tenantId, input.kind);
    const { data: created, error } = await sb
      .from("restaurant_requisitions")
      .insert({
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        reference,
        kind: input.kind,
        department: input.department ?? null,
        source_location_id: input.sourceLocationId,
        destination_location_id: input.destinationLocationId,
        required_date: input.requiredDate ?? null,
        notes: input.notes ?? null,
        status: input.submit ? "submitted" : "draft",
        requested_by: userId,
        submitted_at: input.submit ? now : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    requisitionId = created.id as string;
  }

  const { error: lineErr } = await sb.from("restaurant_requisition_lines").insert(
    input.lines.map((l, idx) => ({
      tenant_id: input.tenantId,
      requisition_id: requisitionId,
      inventory_item_id: l.inventoryItemId,
      unit_id: l.unitId ?? items.get(l.inventoryItemId)?.unit_id ?? null,
      description: l.description ?? null,
      requested_quantity: l.requestedQuantity,
      notes: l.notes ?? null,
      sort_order: idx,
    })),
  );
  if (lineErr) throw new Error(lineErr.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.requisition.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.sourceLocationId,
    entityType: "restaurant_requisition",
    entityId: requisitionId!,
    source: "restaurant-os",
    payload: { reference, kind: input.kind, lines: input.lines.length, to_location_id: input.destinationLocationId },
  });
  if (input.kind === "bar") {
    await emitRestaurantEvent(sb, userId, {
      type: "bar.requisition.created",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.destinationLocationId,
      entityType: "restaurant_requisition",
      entityId: requisitionId!,
      source: "restaurant-os",
      payload: { reference, lines: input.lines.length, from_location_id: input.sourceLocationId },
    });
  }

  if (input.submit) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.requisition.submitted",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.sourceLocationId,
      entityType: "restaurant_requisition",
      entityId: requisitionId!,
      source: "restaurant-os",
      payload: { reference },
      dedupeKey: `requisition:submitted:${requisitionId}`,
    });
  }

  return { id: requisitionId as string, reference, status: input.submit ? "submitted" : "draft" };
}

export async function submitRequisition(sb: Sb, userId: string, input: { tenantId: string; requisitionId: string }) {
  await assertCapability(sb, userId, input.tenantId, "requisition.create");
  const { requisition } = await loadRequisition(sb, input.tenantId, input.requisitionId);
  if (requisition.status !== "draft") {
    throw new Error(`Requisition cannot be submitted from status "${requisition.status}".`);
  }
  const now = new Date().toISOString();
  const { error } = await sb
    .from("restaurant_requisitions")
    .update({ status: "submitted", submitted_at: now, updated_at: now })
    .eq("id", input.requisitionId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.requisition.submitted",
    tenantId: input.tenantId,
    propertyId: requisition.property_id ?? undefined,
    locationId: requisition.source_location_id,
    entityType: "restaurant_requisition",
    entityId: input.requisitionId,
    source: "restaurant-os",
    payload: { reference: requisition.reference },
    dedupeKey: `requisition:submitted:${input.requisitionId}`,
  });
  return { status: "submitted" as const };
}

export async function approveRequisition(sb: Sb, userId: string, input: ApproveRequisitionInput) {
  await assertCapability(sb, userId, input.tenantId, "requisition.approve");
  const { requisition, lines } = await loadRequisition(sb, input.tenantId, input.requisitionId);
  if (!["submitted"].includes(requisition.status)) {
    throw new Error(`Requisition cannot be approved from status "${requisition.status}".`);
  }
  const lineIds = new Set(lines.map((l) => l.id));
  for (const l of input.lines) {
    if (!lineIds.has(l.lineId)) throw new Error("Line does not belong to this requisition.");
  }
  const now = new Date().toISOString();
  for (const l of input.lines) {
    const { error } = await sb
      .from("restaurant_requisition_lines")
      .update({ approved_quantity: l.approvedQuantity, updated_at: now })
      .eq("id", l.lineId)
      .eq("tenant_id", input.tenantId);
    if (error) throw new Error(error.message);
  }
  const { error } = await sb
    .from("restaurant_requisitions")
    .update({ status: "approved", approved_by: userId, approved_at: now, updated_at: now })
    .eq("id", input.requisitionId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.requisition.approved",
    tenantId: input.tenantId,
    propertyId: requisition.property_id ?? undefined,
    locationId: requisition.source_location_id,
    entityType: "restaurant_requisition",
    entityId: input.requisitionId,
    source: "restaurant-os",
    payload: { reference: requisition.reference, lines: input.lines.length },
    dedupeKey: `requisition:approved:${input.requisitionId}`,
  });
  return { status: "approved" as const };
}

export async function rejectRequisition(
  sb: Sb,
  userId: string,
  input: { tenantId: string; requisitionId: string; reason: string },
) {
  await assertCapability(sb, userId, input.tenantId, "requisition.approve");
  const { requisition } = await loadRequisition(sb, input.tenantId, input.requisitionId);
  if (!["submitted"].includes(requisition.status)) {
    throw new Error(`Requisition cannot be rejected from status "${requisition.status}".`);
  }
  const now = new Date().toISOString();
  const { error } = await sb
    .from("restaurant_requisitions")
    .update({ status: "rejected", approved_by: userId, approved_at: now, rejected_reason: input.reason, updated_at: now })
    .eq("id", input.requisitionId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.requisition.rejected",
    tenantId: input.tenantId,
    propertyId: requisition.property_id ?? undefined,
    locationId: requisition.source_location_id,
    entityType: "restaurant_requisition",
    entityId: input.requisitionId,
    source: "restaurant-os",
    payload: { reference: requisition.reference, reason: input.reason },
    dedupeKey: `requisition:rejected:${input.requisitionId}`,
  });
  return { status: "rejected" as const };
}

export async function cancelRequisition(
  sb: Sb,
  userId: string,
  input: { tenantId: string; requisitionId: string; reason?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "requisition.create");
  const { requisition } = await loadRequisition(sb, input.tenantId, input.requisitionId);
  if (["fulfilled", "cancelled", "rejected"].includes(requisition.status)) {
    throw new Error(`Requisition cannot be cancelled from status "${requisition.status}".`);
  }
  const { error } = await sb
    .from("restaurant_requisitions")
    .update({ status: "cancelled", notes: input.reason ?? requisition.notes, updated_at: new Date().toISOString() })
    .eq("id", input.requisitionId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { status: "cancelled" as const };
}

/** Issue: stock moves source → destination through the ledger, line by line. */
export async function issueRequisition(sb: Sb, userId: string, input: IssueRequisitionInput) {
  await assertCapability(sb, userId, input.tenantId, "requisition.issue");
  const { requisition, lines } = await loadRequisition(sb, input.tenantId, input.requisitionId);
  if (!["approved", "partially_issued"].includes(requisition.status)) {
    throw new Error(`Requisition cannot be issued from status "${requisition.status}".`);
  }
  const lineById = new Map(lines.map((l) => [l.id as string, l]));
  const items = await itemNameMap(sb, input.tenantId, lines.map((l) => l.inventory_item_id));
  const now = new Date().toISOString();

  let anyIssued = false;
  for (const req of input.lines) {
    if (req.issueQuantity <= 0) continue;
    const line = lineById.get(req.lineId);
    if (!line) throw new Error("Line does not belong to this requisition.");
    const outstanding = outstandingOf(line);
    if (req.issueQuantity - outstanding > 0.0001) {
      throw new Error(`Cannot issue more than the outstanding quantity for ${line.inventory_item_id}.`);
    }
    const item = items.get(line.inventory_item_id);
    if (!item) throw new Error("Inventory item not found.");
    const unitCost = Number(item.average_cost ?? 0);
    const currency = item.currency ?? "TZS";
    const dedupeKey = `requisition:issue:${line.id}:${req.issueQuantity}:${line.issued_quantity ?? 0}`;
    const base = {
      tenantId: input.tenantId,
      propertyId: requisition.property_id ?? item.property_id,
      inventoryItemId: line.inventory_item_id,
      unitId: line.unit_id ?? item.unit_id,
      unitCost,
      currency,
      reason: `Requisition ${requisition.reference}`,
      referenceType: "restaurant_requisition",
      referenceId: requisition.id,
      correlationId: requisition.correlation_id ?? undefined,
      occurredAt: now,
    };
    const out = await insertMovement(sb, userId, {
      ...base,
      locationId: requisition.source_location_id,
      destinationLocationId: requisition.destination_location_id,
      movementType: "transfer_out",
      quantity: -Math.abs(req.issueQuantity),
      dedupeKey: `${dedupeKey}:out`,
    });
    if (!out) continue; // already issued — idempotent no-op
    await insertMovement(sb, userId, {
      ...base,
      locationId: requisition.destination_location_id,
      movementType: "transfer_in",
      quantity: Math.abs(req.issueQuantity),
      dedupeKey: `${dedupeKey}:in`,
    });

    const newIssued = Number(line.issued_quantity ?? 0) + req.issueQuantity;
    const { error } = await sb
      .from("restaurant_requisition_lines")
      .update({ issued_quantity: newIssued, updated_at: now })
      .eq("id", line.id)
      .eq("tenant_id", input.tenantId);
    if (error) throw new Error(error.message);
    line.issued_quantity = newIssued;
    anyIssued = true;
  }

  const remainingOutstanding = lines.reduce((s, l) => s + outstandingOf(l), 0);
  const newStatus = remainingOutstanding <= 0.0001 ? "fulfilled" : "partially_issued";
  const { error: statusErr } = await sb
    .from("restaurant_requisitions")
    .update({
      status: newStatus,
      issued_by: userId,
      issued_at: now,
      updated_at: now,
    })
    .eq("id", input.requisitionId)
    .eq("tenant_id", input.tenantId);
  if (statusErr) throw new Error(statusErr.message);

  if (anyIssued) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.requisition.issued",
      tenantId: input.tenantId,
      propertyId: requisition.property_id ?? undefined,
      locationId: requisition.source_location_id,
      entityType: "restaurant_requisition",
      entityId: input.requisitionId,
      source: "restaurant-os",
      payload: { reference: requisition.reference, status: newStatus },
    });
  }
  if (newStatus === "fulfilled") {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.requisition.fulfilled",
      tenantId: input.tenantId,
      propertyId: requisition.property_id ?? undefined,
      locationId: requisition.destination_location_id,
      entityType: "restaurant_requisition",
      entityId: input.requisitionId,
      source: "restaurant-os",
      payload: { reference: requisition.reference },
      dedupeKey: `requisition:fulfilled:${input.requisitionId}`,
    });
    if (requisition.kind === "bar") {
      await emitRestaurantEvent(sb, userId, {
        type: "bar.requisition.fulfilled",
        tenantId: input.tenantId,
        propertyId: requisition.property_id ?? undefined,
        locationId: requisition.destination_location_id,
        entityType: "restaurant_requisition",
        entityId: input.requisitionId,
        source: "restaurant-os",
        payload: { reference: requisition.reference },
        dedupeKey: `bar:requisition:fulfilled:${input.requisitionId}`,
      });
    }
  }

  return { status: newStatus as "fulfilled" | "partially_issued" };
}
