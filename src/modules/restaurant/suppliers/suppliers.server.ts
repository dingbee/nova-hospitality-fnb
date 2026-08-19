/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { listSuppliersSchema, type UpsertSupplierInput } from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { recordPriceObservation } from "../procurement/pricing.server";

type Sb = any;

const uuid = z.string().uuid();

export async function listSuppliers(sb: Sb, userId: string, input: z.infer<typeof listSuppliersSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_suppliers")
    .select(
      "id, code, name, contact_name, email, phone, address, payment_terms, lead_time_days, reliability_score, status, metadata",
    )
    .eq("tenant_id", input.tenantId)
    .order("name")
    .limit(input.limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listSupplierProducts(sb: Sb, userId: string, tenantId: string, supplierId?: string) {
  await assertTenantRead(sb, userId, tenantId);
  let q = sb
    .from("restaurant_supplier_products")
    .select(
      "id, supplier_id, inventory_item_id, unit_id, supplier_sku, name, pack_size, unit_price, currency, min_order_quantity, lead_time_days, last_price_at, active",
    )
    .eq("tenant_id", tenantId)
    .order("name");
  if (supplierId) q = q.eq("supplier_id", supplierId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertSupplier(sb: Sb, userId: string, input: UpsertSupplierInput) {
  await assertCapability(sb, userId, input.tenantId, "supplier.manage");

  let existingMetadata: Record<string, unknown> = {};
  if (input.id) {
    const { data: existing } = await sb
      .from("restaurant_suppliers")
      .select("metadata")
      .eq("id", input.id)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    existingMetadata = (existing?.metadata as Record<string, unknown>) ?? {};
  }

  const metadata = {
    ...existingMetadata,
    tradingName: input.tradingName ?? null,
    taxNumber: input.taxNumber ?? null,
    billingAddress: input.billingAddress ?? null,
    deliveryAddress: input.deliveryAddress ?? null,
    deliveryDays: input.deliveryDays,
    minimumOrderValue: input.minimumOrderValue ?? null,
    preferred: input.preferred,
    suppliedCategoryIds: input.suppliedCategoryIds,
  };

  const row = {
    tenant_id: input.tenantId,
    name: input.name,
    code: input.code ?? null,
    contact_name: input.contactName ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    payment_terms: input.paymentTerms ?? null,
    lead_time_days: input.leadTimeDays ?? null,
    status: input.status,
    metadata,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_suppliers").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_suppliers").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.supplier.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_supplier",
    entityId: data.id,
    source: "restaurant-os",
    payload: { name: input.name, status: input.status, preferred: input.preferred },
  });
  return data;
}

/* ---------------- Supplier products ---------------- */

export const upsertSupplierProductSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  supplierId: uuid,
  inventoryItemId: uuid.optional(),
  unitId: uuid.optional(),
  supplierSku: z.string().max(80).optional(),
  name: z.string().min(2).max(160),
  packSize: z.number().min(0).optional(),
  unitPrice: z.number().min(0),
  currency: z.string().min(3).max(3).default("TZS"),
  minOrderQuantity: z.number().min(0).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().default(true),
});
export type UpsertSupplierProductInput = z.infer<typeof upsertSupplierProductSchema>;

export const deactivateSupplierProductSchema = z.object({
  tenantId: uuid,
  id: uuid,
  active: z.boolean().default(false),
});

/**
 * Supplier product prices are never overwritten as "history": each write here
 * only refreshes the convenience cache on the product row (`unit_price`,
 * `last_price_at`); the durable record lives in the price-history ledger
 * (procurement/pricing.server.ts), which we append to on every price change.
 */
export async function upsertSupplierProduct(sb: Sb, userId: string, input: UpsertSupplierProductInput) {
  await assertCapability(sb, userId, input.tenantId, "supplier.manage");

  let priceChanged = true;
  if (input.id) {
    const { data: existing } = await sb
      .from("restaurant_supplier_products")
      .select("unit_price")
      .eq("id", input.id)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    priceChanged = existing ? Number(existing.unit_price) !== input.unitPrice : true;
  }

  const now = new Date().toISOString();
  const row = {
    tenant_id: input.tenantId,
    supplier_id: input.supplierId,
    inventory_item_id: input.inventoryItemId ?? null,
    unit_id: input.unitId ?? null,
    supplier_sku: input.supplierSku ?? null,
    name: input.name,
    pack_size: input.packSize ?? null,
    unit_price: input.unitPrice,
    currency: input.currency,
    min_order_quantity: input.minOrderQuantity ?? null,
    lead_time_days: input.leadTimeDays ?? null,
    active: input.active,
    ...(priceChanged ? { last_price_at: now } : {}),
  };
  const q = input.id
    ? sb.from("restaurant_supplier_products").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_supplier_products").insert(row);
  const { data, error } = await q
    .select("id, supplier_id, name, unit_price, currency, last_price_at")
    .single();
  if (error) throw new Error(error.message);

  if (priceChanged) {
    await recordPriceObservation(sb, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      inventoryItemId: input.inventoryItemId,
      supplierProductId: data.id,
      unitId: input.unitId,
      priceType: "quoted",
      price: input.unitPrice,
      currency: input.currency,
      sourceType: "supplier_product_upsert",
      sourceId: data.id,
      dedupeSuffix: now.slice(0, 16),
    });
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.supplier.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_supplier_product",
    entityId: data.id,
    source: "restaurant-os",
    payload: { supplier_id: data.supplier_id, name: data.name, unit_price: Number(data.unit_price) },
  });
  return data;
}

export async function deactivateSupplierProduct(
  sb: Sb,
  userId: string,
  input: z.infer<typeof deactivateSupplierProductSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "supplier.manage");
  const { data, error } = await sb
    .from("restaurant_supplier_products")
    .update({ active: input.active })
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId)
    .select("id, name, active")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
