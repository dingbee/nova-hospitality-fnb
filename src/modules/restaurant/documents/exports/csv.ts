/**
 * RFC 4180 CSV. Excel and Google Sheets both parse this without a wizard.
 */
import { sheetMatrix, metadataMatrix, type ExportSheet, type ExportWorkbook } from "./model";

function escapeCell(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function matrixToCsv(matrix: (string | number | boolean | null)[][]): string {
  return matrix.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

export function sheetToCsv(sheet: ExportSheet): string {
  return matrixToCsv(sheetMatrix(sheet));
}

/**
 * CSV has no sheets. The first data sheet is the payload; extra sheets are
 * appended after a blank line with a `# Sheet` marker so nothing is lost, and
 * metadata trails at the end so the first block stays machine-readable.
 */
export function workbookToCsv(workbook: ExportWorkbook): string {
  const [first, ...rest] = workbook.sheets;
  const blocks: string[] = [first ? sheetToCsv(first) : ""];
  for (const sheet of rest) blocks.push(`# Sheet: ${sheet.name}\r\n${sheetToCsv(sheet)}`);
  blocks.push(`# Metadata\r\n${matrixToCsv(metadataMatrix(workbook.metadata))}`);
  return blocks.filter(Boolean).join("\r\n\r\n");
}