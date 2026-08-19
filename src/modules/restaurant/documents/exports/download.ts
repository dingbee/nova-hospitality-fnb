/**
 * Browser download helpers. Export generation happens off the render path so
 * a large dataset does not freeze the UI while it serialises.
 */
import { workbookToCsv } from "./csv";
import { workbookToXlsx } from "./xlsx";
import type { ExportWorkbook } from "./model";

export function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadWorkbook(workbook: ExportWorkbook, format: "csv" | "xlsx" | "json") {
  const stem = workbook.fileStem;
  if (format === "csv") {
    saveBlob(`${stem}.csv`, new Blob([`\uFEFF${workbookToCsv(workbook)}`], { type: "text/csv;charset=utf-8" }));
    return;
  }
  if (format === "json") {
    const payload = {
      type: workbook.type,
      title: workbook.title,
      metadata: workbook.metadata,
      sheets: workbook.sheets.map((s) => ({
        name: s.name,
        columns: s.columns.map((c) => ({ key: c.key, label: c.label, format: c.format ?? "text" })),
        rows: s.rows,
      })),
    };
    saveBlob(
      `${stem}.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
    );
    return;
  }
  const bytes = await workbookToXlsx(workbook);
  saveBlob(
    `${stem}.xlsx`,
    new Blob([bytes as unknown as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
}