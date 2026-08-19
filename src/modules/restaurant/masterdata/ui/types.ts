/**
 * Explicit row shapes for the Master Data Workbench.
 *
 * The server layer talks to Supabase through an untyped (`any`) client, so
 * inferring `MasterData` from `ReturnType<typeof listAllMasterData>` collapses
 * every field to `any` and hides real mistakes behind implicit-any panel
 * callbacks. These interfaces mirror the exact columns each server query
 * selects (see masterdata.server.ts, suppliers.server.ts, kitchen.server.ts,
 * sales.server.ts, waste.server.ts) so panels get real autocomplete + safety.
 */

export interface RestaurantTenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: Record<string, unknown> | null;
}

export interface PropertyRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  status: string;
}

export interface LocationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  parent_id: string | null;
  slug: string;
  code: string | null;
  name: string;
  location_type: string;
  is_storage: boolean;
  status: string;
  notes: string | null;
}

export interface UnitRow {
  id: string;
  code: string;
  name: string;
  dimension: string;
  base_unit_id: string | null;
  factor: number;
}

export interface InventoryCategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  kind: string;
  sort_order: number;
  active: boolean;
}

export interface ProductCategoryRow {
  id: string;
  property_id?: string | null;
  parent_id: string | null;
  kind: string;
  name: string;
  slug: string;
  description?: string | null;
  sort_order: number;
  active: boolean;
}

export interface InventoryItemRow {
  id: string;
  name: string;
  sku: string | null;
  item_type: string;
  current_quantity: number;
  par_level: number;
  reorder_point: number;
  average_cost: number;
  currency: string;
  status: string;
  category_id: string | null;
  unit_id: string | null;
  location_id: string | null;
  track_batches: boolean;
  allow_negative: boolean;
  purchase_unit_id: string | null;
  consumption_unit_id: string | null;
  pack_size: number | null;
  shelf_life_days: number | null;
}

export interface SupplierMetadata {
  tradingName?: string | null;
  taxNumber?: string | null;
  billingAddress?: string | null;
  deliveryAddress?: string | null;
  deliveryDays?: string[];
  minimumOrderValue?: number | null;
  preferred?: boolean;
  suppliedCategoryIds?: string[];
}

export interface SupplierRow {
  id: string;
  code: string | null;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  payment_terms: string | null;
  lead_time_days: number | null;
  reliability_score: number | null;
  status: string;
  metadata: SupplierMetadata | null;
}

export interface SupplierProductRow {
  id: string;
  supplier_id: string;
  inventory_item_id: string | null;
  unit_id: string | null;
  supplier_sku: string | null;
  name: string;
  pack_size: number | null;
  unit_price: number;
  currency: string;
  min_order_quantity: number | null;
  lead_time_days: number | null;
  last_price_at: string | null;
  active: boolean;
}

export interface StationRow {
  id: string;
  code: string;
  name: string;
  station_type: string;
  target_prep_minutes: number;
  sort_order: number;
  active: boolean;
  location_id: string | null;
}

export interface TableRow {
  id: string;
  code: string;
  name: string;
  zone: string | null;
  seats: number;
  status: string;
  active: boolean;
  location_id: string | null;
}

export interface ServicePeriodRow {
  id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  sort_order: number;
  active: boolean;
  location_id: string | null;
}

export interface WasteReasonRow {
  id: string | null;
  kind: string;
  code: string;
  label: string;
  requires_approval: boolean;
  requires_note: boolean;
  active: boolean;
  builtin: boolean;
}

/** Single snapshot the whole workbench reads from — see `listAllMasterData`. */
export interface MasterData {
  tenant: RestaurantTenantRow | null;
  properties: PropertyRow[];
  locations: LocationRow[];
  units: UnitRow[];
  inventoryCategories: InventoryCategoryRow[];
  productCategories: ProductCategoryRow[];
  inventoryItems: InventoryItemRow[];
  suppliers: SupplierRow[];
  supplierProducts: SupplierProductRow[];
  stations: StationRow[];
  tables: TableRow[];
  servicePeriods: ServicePeriodRow[];
  reasons: WasteReasonRow[];
}
