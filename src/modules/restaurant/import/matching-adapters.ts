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

/** Best match, or null when nothing scores above the floor — never a forced pick. */
export function bestMatch(results: readonly CatalogMatchResult[]): CatalogMatchResult | null {
  return results.length > 0 && results[0]!.score > 0 ? results[0]! : null;
}

export { matchCatalogItem };
