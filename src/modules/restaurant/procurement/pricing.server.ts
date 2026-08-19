/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Durable supplier price history. Historical purchase prices are never
 * overwritten: each observation (quoted / ordered / received / invoiced) is a
 * new row, and the current supplier product price is only a convenience cache.
 */
import type { z } from "zod";
import { assertTenantRead } from "../core/access.server";
import type { listPriceHistorySchema, supplierPerformanceSchema } from "./contracts";

type Sb = any;

export type PriceObservationType = "quoted" | "ordered" | "received" | "invoiced";

export async function recordPriceObservation(
  sb: Sb,
  obs: {
    tenantId: string;
    supplierId?: string | null;
    inventoryItemId?: string | null;
    supplierProductId?: string | null;
    unitId?: string | null;
    priceType: PriceObservationType;
    price: number;
    quantity?: number | null;
    currency: string;
    effectiveDate?: string;
    sourceType: string;
    sourceId?: string | null;
    dedupeSuffix?: string;
  },
): Promise<void> {
  if (!obs.supplierId) return;
  const dedupeKey = [
    obs.priceType,
    obs.sourceType,
    obs.sourceId ?? "none",
    obs.inventoryItemId ?? "none",
    obs.dedupeSuffix ?? "",
  ].join(":");
  const { error } = await sb.from("restaurant_supplier_price_history").insert({
    tenant_id: obs.tenantId,
    supplier_id: obs.supplierId,
    inventory_item_id: obs.inventoryItemId ?? null,
    supplier_product_id: obs.supplierProductId ?? null,
    unit_id: obs.unitId ?? null,
    price_type: obs.priceType,
    price: obs.price,
    quantity: obs.quantity ?? null,
    currency: obs.currency,
    effective_date: obs.effectiveDate ?? new Date().toISOString().slice(0, 10),
    source_type: obs.sourceType,
    source_id: obs.sourceId ?? null,
    dedupe_key: dedupeKey,
  });
  // 23505 = the same observation already recorded; price history is idempotent.
  if (error && String(error.code) !== "23505") {
    console.warn("[procurement] price observation not recorded", error.message);
  }
}

export async function listPriceHistory(sb: Sb, userId: string, input: z.infer<typeof listPriceHistorySchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const since = new Date(Date.now() - input.sinceDays * 86_400_000).toISOString().slice(0, 10);
  let q = sb
    .from("restaurant_supplier_price_history")
    .select(
      "id, supplier_id, inventory_item_id, unit_id, price_type, price, quantity, currency, effective_date, source_type, source_id",
    )
    .eq("tenant_id", input.tenantId)
    .gte("effective_date", since)
    .order("effective_date", { ascending: false })
    .limit(input.limit);
  if (input.supplierId) q = q.eq("supplier_id", input.supplierId);
  if (input.inventoryItemId) q = q.eq("inventory_item_id", input.inventoryItemId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as any[];
  const [{ data: suppliers }, { data: items }] = await Promise.all([
    sb.from("restaurant_suppliers").select("id, name").eq("tenant_id", input.tenantId),
    sb.from("restaurant_inventory_items").select("id, name").eq("tenant_id", input.tenantId),
  ]);
  const supplierName = new Map(((suppliers ?? []) as any[]).map((s) => [s.id, s.name]));
  const itemName = new Map(((items ?? []) as any[]).map((i) => [i.id, i.name]));

  return rows.map((r) => ({
    ...r,
    supplier_name: supplierName.get(r.supplier_id) ?? "—",
    item_name: itemName.get(r.inventory_item_id) ?? "—",
  }));
}

/**
 * Supplier performance *evidence*, not scores. The Intelligence Core turns this
 * into judgement; procurement only reports what happened.
 */
export async function supplierPerformanceEvidence(
  sb: Sb,
  userId: string,
  input: z.infer<typeof supplierPerformanceSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const sinceIso = new Date(Date.now() - input.sinceDays * 86_400_000).toISOString();

  const [{ data: suppliers }, { data: orders }, { data: receipts }, { data: receiptItems }, { data: variances }] =
    await Promise.all([
      sb.from("restaurant_suppliers").select("id, name, lead_time_days").eq("tenant_id", input.tenantId),
      sb
        .from("restaurant_purchase_orders")
        .select("id, supplier_id, expected_at, requested_delivery_date, order_date, status, total")
        .eq("tenant_id", input.tenantId)
        .gte("created_at", sinceIso),
      sb
        .from("restaurant_goods_receipts")
        .select("id, supplier_id, purchase_order_id, received_at, expected_at, status")
        .eq("tenant_id", input.tenantId)
        .gte("created_at", sinceIso),
      sb
        .from("restaurant_goods_receipt_items")
        .select("receipt_id, ordered_quantity, received_quantity, accepted_quantity, rejected_quantity, damaged_quantity, ordered_unit_cost, unit_cost")
        .eq("tenant_id", input.tenantId),
      sb
        .from("restaurant_procurement_variances")
        .select("supplier_id, variance_type, status")
        .eq("tenant_id", input.tenantId)
        .gte("detected_at", sinceIso),
    ]);

  const receiptRows = (receipts ?? []) as any[];
  const itemRows = (receiptItems ?? []) as any[];
  const byReceipt = new Map<string, any[]>();
  for (const it of itemRows) {
    const list = byReceipt.get(it.receipt_id) ?? [];
    list.push(it);
    byReceipt.set(it.receipt_id, list);
  }

  return ((suppliers ?? []) as any[]).map((s) => {
    const sOrders = ((orders ?? []) as any[]).filter((o) => o.supplier_id === s.id);
    const sReceipts = receiptRows.filter((r) => r.supplier_id === s.id && r.status === "posted");

    let ordered = 0;
    let received = 0;
    let accepted = 0;
    let rejected = 0;
    let damaged = 0;
    let priceDeltaSum = 0;
    let priceDeltaCount = 0;
    let onTime = 0;
    let lateDays = 0;

    for (const r of sReceipts) {
      for (const it of byReceipt.get(r.id) ?? []) {
        ordered += Number(it.ordered_quantity ?? 0);
        received += Number(it.received_quantity ?? 0);
        accepted += Number(it.accepted_quantity ?? 0);
        rejected += Number(it.rejected_quantity ?? 0);
        damaged += Number(it.damaged_quantity ?? 0);
        const oc = Number(it.ordered_unit_cost ?? 0);
        if (oc > 0) {
          priceDeltaSum += (Number(it.unit_cost ?? 0) - oc) / oc;
          priceDeltaCount += 1;
        }
      }
      if (r.expected_at) {
        const diff = Math.round(
          (new Date(r.received_at).getTime() - new Date(`${r.expected_at}T00:00:00Z`).getTime()) / 86_400_000,
        );
        if (diff <= 0) onTime += 1;
        else lateDays += diff;
      }
    }

    const sVariances = ((variances ?? []) as any[]).filter((v) => v.supplier_id === s.id);

    return {
      supplierId: s.id,
      supplierName: s.name,
      statedLeadTimeDays: s.lead_time_days ?? null,
      orders: sOrders.length,
      receipts: sReceipts.length,
      orderedQuantity: Number(ordered.toFixed(3)),
      receivedQuantity: Number(received.toFixed(3)),
      acceptedQuantity: Number(accepted.toFixed(3)),
      rejectedQuantity: Number(rejected.toFixed(3)),
      damagedQuantity: Number(damaged.toFixed(3)),
      fulfilmentRate: ordered > 0 ? Number((received / ordered).toFixed(4)) : null,
      rejectionRate: received > 0 ? Number(((rejected + damaged) / received).toFixed(4)) : null,
      averagePriceVariancePct:
        priceDeltaCount > 0 ? Number(((priceDeltaSum / priceDeltaCount) * 100).toFixed(2)) : null,
      onTimeReceipts: onTime,
      lateDaysTotal: lateDays,
      openVariances: sVariances.filter((v) => v.status === "open").length,
    };
  });
}
