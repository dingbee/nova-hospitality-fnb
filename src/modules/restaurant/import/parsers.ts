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

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  /** One object per row, keyed by header exactly as it appeared in the source. */
  rows: Array<Record<string, string>>;
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

function rowsToSheet(sheetName: string, table: string[][]): ParsedSheet {
  const headerRow = (table[0] ?? []).map((h) => h.trim());
  const headers = headerRow.filter((h) => h.length > 0);
  const rows = table.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headerRow.forEach((h, i) => {
      if (h) obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
  return { sheetName, headers, rows };
}

/** Comma-delimited CSV — the standard export format for most POS/spreadsheet tools. */
export function parseCsv(text: string): ParsedSource {
  return { sheets: [rowsToSheet("Sheet1", splitDelimited(text, ","))] };
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
    const table = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
    return rowsToSheet(
      sheetName,
      table.map((r) => r.map((c) => String(c ?? "").trim())),
    );
  });
  return { sheets: sheets.filter((s) => s.headers.length > 0) };
}
