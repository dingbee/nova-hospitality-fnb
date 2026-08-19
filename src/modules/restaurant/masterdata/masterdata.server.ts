/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import type {
  UpsertBusinessProfileInput,
  UpsertInventoryCategoryInput,
  UpsertInventoryUnitInput,
  UpsertPropertyInput,
  UpsertProductCategoryInput,
  listAllMasterDataSchema,
  listInventoryCategoriesSchema,
} from "./contracts";

type Sb = any;

/* ---------------- Business profile & properties ---------------- */

export async function upsertProperty(sb: Sb, userId: string, input: UpsertPropertyInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const row = {
    tenant_id: input.tenantId,
    slug: input.slug,
    name: input.name,
    timezone: input.timezone,
    currency: input.currency,
    status: input.status,
  };
  const q = input.id
    ? sb.from("restaurant_properties").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_properties").insert({ ...row, settings: {} });
  const { data, error } = await q.select("id, name, slug, status").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function upsertBusinessProfile(sb: Sb, userId: string, input: UpsertBusinessProfileInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data: tenant, error: readErr } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", input.tenantId)
    .single();
  if (readErr) throw new Error(readErr.message);
  const settings = {
    ...(tenant?.settings ?? {}),
    business: {
      legalName: input.legalName,
      tradingName: input.tradingName ?? null,
      code: input.code ?? null,
      taxId: input.taxId ?? null,
      defaultCurrency: input.defaultCurrency,
      timezone: input.timezone,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
    },
  };
  const { data, error } = await sb
    .from("restaurant_tenants")
    .update({ settings })
    .eq("id", input.tenantId)
    .select("id, name, slug, settings")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------- Inventory units ---------------- */

export async function upsertInventoryUnit(sb: Sb, userId: string, input: UpsertInventoryUnitInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  if (input.baseUnitId && input.id && input.baseUnitId === input.id) {
    throw new Error("A unit cannot be its own base unit.");
  }
  const row = {
    tenant_id: input.tenantId,
    code: input.code,
    name: input.name,
    dimension: input.dimension,
    base_unit_id: input.baseUnitId ?? null,
    factor: input.factor,
  };
  const q = input.id
    ? sb.from("restaurant_inventory_units").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_units").insert(row);
  const { data, error } = await q.select("id, code, name, dimension, factor, base_unit_id").single();
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------- Inventory categories ---------------- */

export async function listInventoryCategories(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listInventoryCategoriesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_inventory_categories")
    .select("id, parent_id, name, slug, kind, sort_order, active")
    .eq("tenant_id", input.tenantId)
    .order("sort_order");
  if (input.kind) q = q.eq("kind", input.kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertInventoryCategory(sb: Sb, userId: string, input: UpsertInventoryCategoryInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const row = {
    tenant_id: input.tenantId,
    parent_id: input.parentId ?? null,
    name: input.name,
    slug: input.slug,
    kind: input.kind,
    sort_order: input.sortOrder,
    active: input.active,
  };
  const q = input.id
    ? sb.from("restaurant_inventory_categories").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_categories").insert(row);
  const { data, error } = await q.select("id, name, kind, active").single();
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------- Product / menu categories ---------------- */

export async function upsertProductCategory(sb: Sb, userId: string, input: UpsertProductCategoryInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    parent_id: input.parentId ?? null,
    kind: input.kind,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    sort_order: input.sortOrder,
    active: input.active,
  };
  const q = input.id
    ? sb.from("restaurant_categories").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_categories").insert(row);
  const { data, error } = await q.select("id, name, kind, active").single();
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------- One-call workbench snapshot ---------------- */

export async function listAllMasterData(sb: Sb, userId: string, input: z.infer<typeof listAllMasterDataSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const tenantId = input.tenantId;

  const [inventoryMod, menuMod, suppliersMod, kitchenMod, salesMod, wasteMod] = await Promise.all([
    import("../inventory/inventory.server"),
    import("../menu/menu.server"),
    import("../suppliers/suppliers.server"),
    import("../kitchen/kitchen.server"),
    import("../sales/sales.server"),
    import("../inventory/waste.server"),
  ]);

  const [
    { data: tenantRow },
    { data: properties, error: propErr },
    { data: locations, error: locErr },
    units,
    inventoryCategories,
    productCategories,
    { data: inventoryItems, error: itemErr },
    suppliers,
    supplierProducts,
    stations,
    tables,
    servicePeriods,
    reasons,
  ] = await Promise.all([
    sb.from("restaurant_tenants").select("id, slug, name, status, settings").eq("id", tenantId).single(),
    sb
      .from("restaurant_properties")
      .select("id, tenant_id, slug, name, timezone, currency, status")
      .eq("tenant_id", tenantId)
      .order("name"),
    sb
      .from("restaurant_locations")
      .select(
        "id, tenant_id, property_id, parent_id, slug, code, name, location_type, is_storage, status, notes",
      )
      .eq("tenant_id", tenantId)
      .order("name"),
    inventoryMod.listUnits(sb, userId, tenantId),
    listInventoryCategories(sb, userId, { tenantId }),
    menuMod.listCategories(sb, userId, { tenantId, kind: "menu" }),
    sb
      .from("restaurant_inventory_items")
      .select(
        "id, name, sku, item_type, current_quantity, par_level, reorder_point, average_cost, currency, status, category_id, unit_id, location_id, track_batches, allow_negative, purchase_unit_id, consumption_unit_id, pack_size, shelf_life_days",
      )
      .eq("tenant_id", tenantId)
      .order("name"),
    suppliersMod.listSuppliers(sb, userId, { tenantId, limit: 300 }),
    suppliersMod.listSupplierProducts(sb, userId, tenantId),
    kitchenMod.listStations(sb, userId, { tenantId }),
    salesMod.listTables(sb, userId, { tenantId }),
    salesMod.listServicePeriods(sb, userId, { tenantId }),
    wasteMod.listReasons(sb, userId, { tenantId }),
  ]);

  if (propErr) throw new Error(propErr.message);
  if (locErr) throw new Error(locErr.message);
  if (itemErr) throw new Error(itemErr.message);

  return {
    tenant: tenantRow ?? null,
    properties: properties ?? [],
    locations: locations ?? [],
    units,
    inventoryCategories,
    productCategories,
    inventoryItems: inventoryItems ?? [],
    suppliers,
    supplierProducts,
    stations,
    tables,
    servicePeriods,
    reasons,
  };
}
