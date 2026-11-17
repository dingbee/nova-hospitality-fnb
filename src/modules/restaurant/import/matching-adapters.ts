/**
 * O7 Import Studio — domain adapters over the O6 matching engine.
 *
 * Every domain's "does this already exist?" question is answered by the same
 * `matchCatalogItem` (catalog/matching.ts) the receiving basket and stocktake
 * use — these adapters only reshape each domain's rows into
 * `CatalogMatchCandidate`s, they do not re-implement scoring.
 */
import {
  matchCatalogItem,
  type CatalogMatchCandidate,
  type CatalogMatchResult,
} from "../catalog/matching";

export interface SupplierRow {
  id: string;
  code: string | null;
  name: string;
}
export interface InventoryItemRow {
  id: string;
  sku: string | null;
  name: string;
  barcode: string | null;
  brand: string | null;
}
export interface MenuItemRow {
  id: string;
  name: string;
  menu_id: string;
}
export interface StationRow {
  id: string;
  code: string;
  name: string;
}
export interface ProductRow {
  id: string;
  menu_item_id: string | null;
  station_id: string | null;
  sku: string | null;
}
export interface ModifierGroupRow {
  id: string;
  code: string;
  name: string;
}
export interface MenuRow {
  id: string;
  slug: string;
  name: string;
}
export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
}

export function supplierCandidates(rows: readonly SupplierRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.code ?? r.id, name: r.name }));
}

export function inventoryItemCandidates(
  rows: readonly InventoryItemRow[],
): CatalogMatchCandidate[] {
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku ?? r.id,
    name: r.name,
    barcode: r.barcode,
    brand: r.brand,
  }));
}

export function menuItemCandidates(rows: readonly MenuItemRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.id, name: r.name }));
}

/** Stations are matched by their tenant-unique code — the same identity a client proposes/never overrides (stationRouting.ts). */
export function stationCandidates(rows: readonly StationRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.code, name: r.name }));
}

/** Modifier groups are matched by their tenant-unique code, same as a supplier's own code. */
export function modifierGroupCandidates(
  rows: readonly ModifierGroupRow[],
): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.code, name: r.name }));
}

/**
 * Products (the menu-item ↔ station bridge row) are matched by their own
 * tenant-unique SKU — the "Item Code" a LexiBite template row cross-
 * references directly, rather than the dish's name. A product with no sku
 * yet (should not normally happen — product_station always sets one) falls
 * back to its own id so it can never accidentally collide with a real code.
 */
export function productCandidates(rows: readonly ProductRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.sku ?? r.id, name: r.sku ?? r.id }));
}

/** Menus are matched by their tenant-unique slug (the LexiBite template's Menu Code, normalised). */
export function menuCandidates(rows: readonly MenuRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.slug, name: r.name }));
}

/** Categories are matched by their tenant-unique (per kind) slug — the LexiBite template's Category Code, normalised. */
export function categoryCandidates(rows: readonly CategoryRow[]): CatalogMatchCandidate[] {
  return rows.map((r) => ({ id: r.id, sku: r.slug, name: r.name }));
}

/** Best match, or null when nothing scores above the floor — never a forced pick. */
export function bestMatch(results: readonly CatalogMatchResult[]): CatalogMatchResult | null {
  return results.length > 0 && results[0]!.score > 0 ? results[0]! : null;
}

export { matchCatalogItem };
