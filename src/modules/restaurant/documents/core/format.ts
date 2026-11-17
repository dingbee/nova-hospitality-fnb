/**
 * Deterministic, machine-readable value formatting shared by every renderer
 * and exporter. Spreadsheet exports must never contain locale-formatted
 * numbers or dates: Excel and Google Sheets have to parse them natively.
 */
import type { CellValue, ColumnFormat } from "./types";

/** ISO date (YYYY-MM-DD) — machine readable in every spreadsheet. */
export function isoDate(value: CellValue): string {
  if (value == null || value === "") return "";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

/** ISO datetime without milliseconds. */
export function isoDateTime(value: CellValue): string {
  if (value == null || value === "") return "";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : `${d.toISOString().slice(0, 19)}Z`;
}

export function toNumber(value: CellValue): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Raw cell value for spreadsheet output: numbers stay numbers, dates become
 * ISO strings, nothing is padded with currency symbols or thousands
 * separators.
 */
export function machineValue(value: CellValue, format: ColumnFormat = "text"): string | number | boolean | null {
  switch (format) {
    case "integer":
    case "number":
    case "money":
    case "percent": {
      const n = toNumber(value);
      return n == null ? "" : n;
    }
    case "date":
      return isoDate(value);
    case "datetime":
      return isoDateTime(value);
    default:
      return value == null ? "" : value;
  }
}

/** Human display value for printed documents only. */
export function displayValue(value: CellValue, format: ColumnFormat = "text", currency?: string | null): string {
  if (value == null || value === "") return "—";
  switch (format) {
    case "integer":
      return String(Math.round(Number(value)));
    case "number":
      return Number(value).toLocaleString("en-GB", { maximumFractionDigits: 3 });
    case "money":
      return `${currency ? `${currency} ` : ""}${Number(value).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    case "percent":
      return `${Number(value).toFixed(2)}%`;
    case "date":
      return isoDate(value);
    case "datetime":
      return isoDateTime(value).replace("T", " ").replace("Z", "");
    default:
      return String(value);
  }
}

/** Filesystem-safe file name stem. */
export function fileStem(parts: Array<string | null | undefined>): string {
  return parts
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}