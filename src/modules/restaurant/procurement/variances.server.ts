/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Procurement variance control. Discrepancies are recorded, never auto-approved.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { recordProcurementAudit } from "./audit.server";
import type { listVariancesSchema, resolveVarianceSchema, VarianceType } from "./contracts";

type Sb = any;

export interface VarianceDraft {
  tenantId: string;
  propertyId?: string | null;
  locationId?: string | null;
  varianceType: VarianceType;
  severity?: "low" | "medium" | "high";
  label: string;
  purchaseOrderId?: string | null;
  receiptId?: string | null;
  receiptItemId?: string | null;
  invoiceId?: string | null;
  supplierId?: string | null;
  expectedValue?: number | null;
  actualValue?: number | null;
  unit?: string | null;
  currency?: string | null;
  detail?: Record<string, unknown>;
  dedupeKey: string;
}

/** Idempotent: the same discrepancy is only ever raised once. */
export async function raiseVariance(sb: Sb, userId: string, draft: VarianceDraft) {
  const expected = draft.expectedValue ?? null;
  const actual = draft.actualValue ?? null;
  const delta = expected != null && actual != null ? actual - expected : null;
  const pct = delta != null && expected ? (delta / Math.abs(expected)) * 100 : null;

  const { data, error } = await sb
    .from("restaurant_procurement_variances")
    .insert({
      tenant_id: draft.tenantId,
      property_id: draft.propertyId ?? null,
      location_id: draft.locationId ?? null,
      variance_type: draft.varianceType,
      severity: draft.severity ?? "medium",
      status: "open",
      purchase_order_id: draft.purchaseOrderId ?? null,
      receipt_id: draft.receiptId ?? null,
      receipt_item_id: draft.receiptItemId ?? null,
      invoice_id: draft.invoiceId ?? null,
      supplier_id: draft.supplierId ?? null,
      label: draft.label,
      expected_value: expected,
      actual_value: actual,
      variance_value: delta,
      variance_pct: pct != null ? Number(pct.toFixed(4)) : null,
      unit: draft.unit ?? null,
      currency: draft.currency ?? null,
      detail: draft.detail ?? {},
      dedupe_key: draft.dedupeKey,
    })
    .select("id, variance_type, label")
    .single();

  if (error) {
    if (String(error.code) === "23505") return null;
    throw new Error(error.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.purchase.variance.detected",
    tenantId: draft.tenantId,
    propertyId: draft.propertyId ?? undefined,
    locationId: draft.locationId ?? undefined,
    entityType: "restaurant_procurement_variance",
    entityId: data.id,
    source: "restaurant-os",
    dedupeKey: `restaurant.variance.${draft.dedupeKey}`,
    payload: {
      variance_type: draft.varianceType,
      label: draft.label,
      expected: expected,
      actual: actual,
      variance_pct: pct != null ? Number(pct.toFixed(2)) : null,
      supplier_id: draft.supplierId ?? null,
    },
  });

  return data;
}

export async function listVariances(sb: Sb, userId: string, input: z.infer<typeof listVariancesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_procurement_variances")
    .select(
      "id, variance_type, severity, status, label, expected_value, actual_value, variance_value, variance_pct, unit, currency, supplier_id, purchase_order_id, receipt_id, invoice_id, detail, detected_at, resolved_at, resolution_notes",
    )
    .eq("tenant_id", input.tenantId)
    .order("detected_at", { ascending: false })
    .limit(input.limit);
  if (input.status) q = q.eq("status", input.status);
  if (input.varianceType) q = q.eq("variance_type", input.varianceType);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const { data: suppliers } = await sb
    .from("restaurant_suppliers")
    .select("id, name")
    .eq("tenant_id", input.tenantId);
  const names = new Map(((suppliers ?? []) as any[]).map((s) => [s.id, s.name]));
  return ((data ?? []) as any[]).map((v) => ({ ...v, supplier_name: names.get(v.supplier_id) ?? null }));
}

export async function resolveVariance(sb: Sb, userId: string, input: z.infer<typeof resolveVarianceSchema>) {
  await assertCapability(sb, userId, input.tenantId, "variance.manage");
  const { data: before } = await sb
    .from("restaurant_procurement_variances")
    .select("id, status, label")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .single();
  if (!before) throw new Error("Variance not found.");

  const { data, error } = await sb
    .from("restaurant_procurement_variances")
    .update({
      status: input.status,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolution_notes: input.notes ?? null,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .select("id, status")
    .single();
  if (error) throw new Error(error.message);

  await recordProcurementAudit(sb, userId, {
    tenantId: input.tenantId,
    documentType: "variance_report",
    documentId: input.id,
    action: "variance_decision",
    previousState: before.status,
    newState: input.status,
    reason: input.notes ?? null,
    metadata: { label: before.label },
  });
  return data;
}
