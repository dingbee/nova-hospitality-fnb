/**
 * XLSX rendering. Loaded lazily and only in the browser: workbook generation
 * is a client concern, which also keeps large exports off the server runtime.
 */
import { metadataMatrix, safeSheetName, sheetMatrix, type ExportWorkbook } from "./model";

export async function workbookToXlsx(workbook: ExportWorkbook): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // Metadata first so a human opening the file knows its provenance, while
  // every raw-data sheet stays a clean header + rows grid.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metadataMatrix(workbook.metadata)), "Metadata");

  const used = new Set<string>(["Metadata"]);
  for (const sheet of workbook.sheets) {
    let name = safeSheetName(sheet.name);
    let i = 2;
    while (used.has(name)) name = safeSheetName(`${sheet.name} ${i++}`);
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet(sheetMatrix(sheet));
    ws["!cols"] = sheet.columns.map((c) => ({ wch: Math.min(40, Math.max(10, c.label.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(out as ArrayBuffer);
}