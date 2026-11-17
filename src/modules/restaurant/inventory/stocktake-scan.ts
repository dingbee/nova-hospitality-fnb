/**
 * Stocktake camera scanning — identification only, never mutation.
 *
 * A stocktake's lines are fixed the moment counting starts (a snapshot of
 * the ledger at that instant — see stocktake.server.ts's startStocktake).
 * Scanning a barcode here can only ever select which of those *existing*
 * lines the staff member is about to count; it can never create, remove,
 * or resolve a line on its own, and it never touches the ledger — the
 * counted quantity still only reaches inventory through the existing
 * save-counts / approve-and-post path once a human confirms it.
 *
 * Exact match only, by design: a physical barcode scan is either the
 * item's own barcode or it isn't — there is no ambiguity to fuzzy-resolve
 * the way there is for typed/OCR'd text (that's what catalog/matching.ts
 * is for), so reusing it here would add a scoring step this exact-identity
 * lookup doesn't need.
 */

export interface StocktakeScanLine {
  id: string;
  item_name: string;
  item_sku: string | null;
  item_barcode: string | null;
}

export type StocktakeScanResult =
  { line: StocktakeScanLine; message: null } | { line: null; message: string };

/**
 * Finds the stocktake line a scanned code identifies. Pure: never mutates
 * `lines`, never adds or removes an entry — an unmatched code is reported
 * back for a human to count by hand rather than guessed at or fabricated
 * into a new line.
 */
export function matchStocktakeLineByCode(
  lines: readonly StocktakeScanLine[],
  code: string,
): StocktakeScanResult {
  const match = lines.find((l) => l.item_barcode === code || l.item_sku === code);
  if (!match) {
    return {
      line: null,
      message: `No item on this stocktake matches "${code}". Count it by hand below.`,
    };
  }
  return { line: match, message: null };
}

/** Case-insensitive substring match over name, SKU and barcode — the manual fallback that must always work, camera or not. */
export function filterStocktakeLines(
  lines: readonly StocktakeScanLine[],
  query: string,
): readonly StocktakeScanLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter(
    (l) =>
      l.item_name.toLowerCase().includes(q) ||
      (l.item_sku?.toLowerCase().includes(q) ?? false) ||
      (l.item_barcode?.toLowerCase().includes(q) ?? false),
  );
}
