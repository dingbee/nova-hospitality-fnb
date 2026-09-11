/**
 * LexiBite Import Template — workbook generator.
 *
 * Builds the actual downloadable .xlsx from the canonical definition in
 * template.ts, using the `xlsx` (SheetJS Community Edition) dependency this
 * project already has — no new dependency added. Runs equally in the
 * browser (the download button calls this directly) or in Node (tests),
 * since `xlsx` itself is isomorphic.
 *
 * Two real SheetJS CE limitations shape this file, confirmed empirically
 * against the installed version (0.18.5) before writing it: native Excel
 * Data Validation (dropdown lists) and frozen panes are Pro-only features
 * with no write support in the open-source package. Column widths,
 * AutoFilter and cell comments genuinely do write correctly (verified by
 * round-tripping a real .xlsx through the library and inspecting the raw
 * OOXML). Where the spec asks for "data validation/dropdowns where
 * practical" (Part 5), the practical substitute here is a column-header
 * comment listing the valid values — the same information, just not a
 * native in-cell dropdown. Freeze panes are simply not produced; every
 * sheet still has a bold-free but unambiguous single header row plus
 * AutoFilter, which keeps the sheet usable without it.
 */
import * as XLSX from "xlsx";
import {
  LEXIBITE_START_HERE,
  LEXIBITE_TEMPLATE_FILENAME,
  LEXIBITE_TEMPLATE_MARKER,
  LEXIBITE_TEMPLATE_SHEETS,
  LEXIBITE_TEMPLATE_VERSION,
  LEXIBITE_UNIT_GUIDE,
  type TemplateSheetDef,
} from "./template";

const META_SHEET_NAME = "_lexibite_meta";

function columnWidth(header: string, values: readonly string[]): number {
  const longest = values.reduce((max, v) => Math.max(max, v.length), 0);
  return Math.min(40, Math.max(10, header.length + 2, longest + 2));
}

function buildStartHereSheet(): XLSX.WorkSheet {
  const aoa: string[][] = [];
  aoa.push([LEXIBITE_START_HERE.title]);
  aoa.push([LEXIBITE_START_HERE.intro]);
  aoa.push([]);
  aoa.push(["Getting started"]);
  LEXIBITE_START_HERE.steps.forEach((step, i) => aoa.push([`${i + 1}. ${step}`]));
  aoa.push([]);
  aoa.push(["Required sheets", LEXIBITE_START_HERE.requiredSheets.join(", ")]);
  aoa.push(["Optional sheets", LEXIBITE_START_HERE.optionalSheets.join(", ")]);
  aoa.push([]);
  aoa.push(["How relationships work"]);
  LEXIBITE_START_HERE.relationships.forEach((r) => aoa.push([r]));
  aoa.push([]);
  aoa.push(["Example codes", "", LEXIBITE_START_HERE.codeExamplesNote]);
  LEXIBITE_START_HERE.codeExamples.forEach((c) => aoa.push([c.kind, c.example]));
  aoa.push([]);
  aoa.push(["Unit guide"]);
  LEXIBITE_UNIT_GUIDE.forEach((u) => aoa.push([u.code, u.meaning]));
  aoa.push([]);
  aoa.push([LEXIBITE_TEMPLATE_MARKER]);
  aoa.push([`Template Version: ${LEXIBITE_TEMPLATE_VERSION}`]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 46 }, { wch: 30 }, { wch: 40 }];
  return ws;
}

function buildMetaSheet(): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([
    [LEXIBITE_TEMPLATE_MARKER],
    [`Template Version: ${LEXIBITE_TEMPLATE_VERSION}`],
  ]);
  return ws;
}

function addComment(ws: XLSX.WorkSheet, cellRef: string, text: string): void {
  const cell = ws[cellRef];
  if (!cell) return;
  cell.c = cell.c ?? [];
  cell.c.push({ a: "LexiBite", t: text });
}

function buildOperationalSheet(sheet: TemplateSheetDef): XLSX.WorkSheet {
  const headers = sheet.columns.map((c) => c.header);
  const aoa: string[][] = [headers];
  for (const row of sheet.exampleRows) {
    aoa.push(headers.map((h) => row[h] ?? ""));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws["!cols"] = sheet.columns.map((c) => ({
    wch: columnWidth(
      c.header,
      sheet.exampleRows.map((r) => r[c.header] ?? ""),
    ),
  }));
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }),
  };

  sheet.columns.forEach((col, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
    const parts: string[] = [];
    if (col.required) parts.push("Required.");
    if (col.comment) parts.push(col.comment);
    if (col.choices && col.choices.length > 0)
      parts.push(`Valid values: ${col.choices.join(", ")}.`);
    if (parts.length > 0) addComment(ws, cellRef, parts.join(" "));
  });

  if (sheet.exampleRows.length > 0) {
    addComment(
      ws,
      XLSX.utils.encode_cell({ r: 1, c: 0 }),
      `Example row${sheet.exampleRows.length > 1 ? "s" : ""} — delete before entering your own data.`,
    );
  }

  return ws;
}

/** Builds the full LexiBite Import Template workbook from the canonical definition. */
export function buildLexibiteTemplateWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildStartHereSheet(), "START HERE");
  for (const sheet of LEXIBITE_TEMPLATE_SHEETS) {
    XLSX.utils.book_append_sheet(wb, buildOperationalSheet(sheet), sheet.name);
  }
  XLSX.utils.book_append_sheet(wb, buildMetaSheet(), META_SHEET_NAME);
  const metaIndex = wb.SheetNames.indexOf(META_SHEET_NAME);
  wb.Workbook = wb.Workbook ?? {};
  wb.Workbook.Sheets = wb.Workbook.Sheets ?? [];
  wb.Workbook.Sheets[metaIndex] = { Hidden: 1 };
  return wb;
}

/** Base64-encoded .xlsx bytes — usable server-side (e.g. for a test fixture) or to hand to a browser download. */
export function lexibiteTemplateBase64(): string {
  const wb = buildLexibiteTemplateWorkbook();
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

/** Browser-only: builds the workbook and triggers a file download. No server round-trip. */
export function downloadLexibiteTemplate(filename: string = LEXIBITE_TEMPLATE_FILENAME): void {
  const wb = buildLexibiteTemplateWorkbook();
  XLSX.writeFile(wb, filename);
}
