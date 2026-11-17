/**
 * O7 Import Studio — raw capture parsers.
 *
 * Pure, deterministic, never inventive: a parser turns a file's bytes into
 * rows of text exactly as written. Nothing here decides what a column
 * *means* (see domains.ts) or resolves it to a canonical entity (see
 * catalog/matching.ts) — this stage only answers "what characters were in
 * the file".
 */
import * as XLSX from "xlsx";
import { ALL_CANONICAL_ALIASES } from "./domains";

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  /** One object per row, keyed by header exactly as it appeared in the source. */
  rows: Array<Record<string, string>>;
  /**
   * Row(s) above the detected header row that were not parsed as data — a
   * title banner, a generated-on/date note, a blank spacer. Preserved
   * (never silently dropped) so a reviewer can confirm nothing real was
   * skipped; empty for the overwhelmingly common case of a sheet whose
   * header genuinely is row 1.
   */
  skippedRows?: string[][];
}

export interface ParsedSource {
  sheets: ParsedSheet[];
}

/** RFC4180-ish: quoted fields, embedded delimiters/newlines inside quotes, "" as an escaped quote. */
function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/**
 * Which row in a raw table is the real header row — evidence-scored, never a
 * workbook-specific rule. A candidate row (scanned within the first 8 rows,
 * where a title banner or a blank spacer realistically lives) scores on two
 * signals any workbook can produce: how many of its own cells are a known
 * canonical field alias (the strongest evidence — "Item Name", "SKU", "Qty"
 * are header words in any restaurant's sheet), and how *shaped* like a
 * header row it is generically — short, distinct, non-numeric cells, unlike
 * a data row's repeated/numeric content. Falls back to row 0 (today's
 * behaviour) whenever nothing in the window scores above a neutral floor, so
 * a sheet whose headers use entirely unfamiliar words is never disturbed.
 */
export function detectHeaderRowIndex(
  table: readonly string[][],
  knownAliases: ReadonlySet<string> = ALL_CANONICAL_ALIASES,
): number {
  const window = Math.min(8, table.length);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < window; i++) {
    const cells = (table[i] ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue; // a title banner or blank spacer rarely fills 2+ cells
    const normalized = cells.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    const aliasHits = normalized.filter((c) => knownAliases.has(c)).length;
    const numericCells = cells.filter((c) => /^-?\d+(\.\d+)?$/.test(c.replace(/,/g, ""))).length;
    const distinct = new Set(normalized).size;
    const score = aliasHits * 3 + distinct * 0.2 - numericCells * 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestScore > 0 ? bestIndex : 0;
}

function rowsToSheet(sheetName: string, table: string[][], headerRowIndex = 0): ParsedSheet {
  const headerRow = (table[headerRowIndex] ?? []).map((h) => h.trim());
  const headers = headerRow.filter((h) => h.length > 0);
  const rows = table.slice(headerRowIndex + 1).map((cells) => {
    const obj: Record<string, string> = {};
    headerRow.forEach((h, i) => {
      if (h) obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
  const skippedRows = table.slice(0, headerRowIndex).filter((r) => r.some((c) => c.trim() !== ""));
  return { sheetName, headers, rows, ...(skippedRows.length > 0 ? { skippedRows } : {}) };
}

/** Comma-delimited CSV — the standard export format for most POS/spreadsheet tools. */
export function parseCsv(text: string): ParsedSource {
  const table = splitDelimited(text, ",");
  return { sheets: [rowsToSheet("Sheet1", table, detectHeaderRowIndex(table))] };
}

/**
 * Pasted tabular data — usually copied straight out of a spreadsheet, which
 * clipboards as tab-delimited. Falls back to comma if no tabs are present
 * rather than guessing at anything more exotic.
 */
export function parsePasted(text: string): ParsedSource {
  const delimiter = text.split("\n")[0]?.includes("\t") ? "\t" : ",";
  return { sheets: [rowsToSheet("Pasted", splitDelimited(text, delimiter))] };
}

/** JSON — either an array of row objects, or an object whose values are each an array of row objects (one "sheet" per key). */
export function parseJson(text: string): ParsedSource {
  const data: unknown = JSON.parse(text);
  const toStringRow = (row: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row))
      out[k] = v === null || v === undefined ? "" : String(v);
    return out;
  };
  const sheetFromArray = (name: string, arr: unknown[]): ParsedSheet => {
    const rows = arr
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map(toStringRow);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { sheetName: name, headers, rows };
  };
  if (Array.isArray(data)) {
    return { sheets: [sheetFromArray("Sheet1", data)] };
  }
  if (data && typeof data === "object") {
    const sheets = Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => Array.isArray(v))
      .map(([name, v]) => sheetFromArray(name, v as unknown[]));
    if (sheets.length > 0) return { sheets };
  }
  throw new Error(
    "Unrecognised JSON shape — expected an array of rows, or an object of named row arrays.",
  );
}

/** XLSX workbook (base64) — every sheet in the workbook, via the existing SheetJS dependency. */
export function parseXlsxBase64(base64: string): ParsedSource {
  const workbook = XLSX.read(base64, { type: "base64" });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName]!;
    const table = XLSX.utils
      .sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" })
      .map((r) => r.map((c) => String(c ?? "").trim()));
    return rowsToSheet(sheetName, table, detectHeaderRowIndex(table));
  });
  return { sheets: sheets.filter((s) => s.headers.length > 0) };
}
