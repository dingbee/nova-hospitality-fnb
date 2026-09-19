/**
 * LexiBite Import Template — workbook generator.
 *
 * The downloadable workbook is intentionally shaped like the customer-facing
 * LexiBite template: START HERE guidance, worked examples at the top of each
 * operational sheet, a large clean entry area, filters, and stable column
 * widths. The import definition remains canonical in template.ts.
 *
 * SheetJS CE does not serialize native cell styling/data validation/freeze
 * panes. We therefore implement the supported workbook structure here and
 * keep validation guidance in header comments. The import semantics do not
 * depend on presentation metadata.
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
const TEMPLATE_ENTRY_ROWS = 1000;

function columnWidth(header: string, values: readonly string[]): number {
  const longest = values.reduce((max, v) => Math.max(max, v.length), 0);
  return Math.min(40, Math.max(10, header.length + 2, longest + 2));
}

function buildStartHereSheet(): XLSX.WorkSheet {
  // Match the customer-facing template layout rather than the older compact
  // generated workbook. Column B carries the long guidance text.
  const rows: string[][] = [
    ["Welcome to LexiBite — Import Template"],
    [],
    ["Template marker", LEXIBITE_TEMPLATE_MARKER],
    ["Template version", LEXIBITE_TEMPLATE_VERSION],
    ["Purpose", "Structured restaurant master-data import for LexiBite Import Studio."],
    [
      "Before upload",
      "DELETE ALL WORKED EXAMPLE ROWS (the shaded rows) and replace them with your own data.",
    ],
    ["Required sheets", "INVENTORY and MENU ITEMS."],
    [
      "Optional sheets",
      "All other operational sheets. Leave them with only the header row if you do not use them.",
    ],
    ["Stable codes", "Use short, unique, stable codes. Cross-sheet references must match exactly."],
    ["Numbers", "Enter quantities/prices as numbers. Do not add currency symbols to numeric cells."],
    ["Units", "Use only the LexiBite unit codes listed below: KG, G, L, ML, PC, BTL, CTN."],
    ["Pack Size", "For an item bought and stocked in the same unit, use 1. Do not leave a deliberate zero."],
    [
      "Bottle contents",
      "For a 750ml bottle: Stock Unit = BTL, Purchase Unit = CTN, Pack Size = 12, Content per Stock Unit = 750, Content Unit = ML.",
    ],
    [
      "Content pair",
      "Content per Stock Unit and Content Unit must either both be supplied or both be blank.",
    ],
    [
      "Relationships",
      "MENU ITEMS Item Code is referenced by VARIANTS, ITEM MODIFIERS and RECIPES. Inventory SKU is referenced by RECIPES and SUPPLIER PRODUCTS.",
    ],
    ["Stations", "Do not create a separate station sheet. MENU ITEMS → Station is the canonical input."],
    ["Modifiers", "If Effect = Inventory, provide Inventory SKU, Quantity and Unit."],
    [
      "Upload",
      "Upload this workbook to LexiBite Import Studio, review staging/mapping, then commit only after all blocking errors are resolved.",
    ],
    [],
    ["LEXIBITE UNIT GUIDE"],
    ...LEXIBITE_UNIT_GUIDE.map((u) => [u.code, u.meaning]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 28 },
    { wch: 88 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
  ];

  // Merge the title, guidance values and unit-guide heading exactly across
  // the presentation width used by the customer-facing template.
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    ...Array.from({ length: 16 }, (_, i) => ({
      s: { r: i + 2, c: 1 },
      e: { r: i + 2, c: 7 },
    })),
    { s: { r: 19, c: 0 }, e: { r: 19, c: 2 } },
  ];

  return ws;
}

function buildMetaSheet(): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([
    [LEXIBITE_TEMPLATE_MARKER],
    [`Template Version: ${LEXIBITE_TEMPLATE_VERSION}`],
  ]);
}

function addComment(ws: XLSX.WorkSheet, cellRef: string, text: string): void {
  const cell = ws[cellRef];
  if (!cell) return;
  cell.c = cell.c ?? [];
  cell.c.push({ a: "LexiBite", t: text });
}

function buildOperationalSheet(sheet: TemplateSheetDef): XLSX.WorkSheet {
  const headers = sheet.columns.map((c) => c.header);

  // Row 1 = canonical headers. Worked examples immediately follow. The
  // remaining rows are deliberately materialised as an entry area so the
  // downloaded workbook opens as a real template, not a tiny example sheet.
  const aoa: string[][] = [headers];

  for (const row of sheet.exampleRows) {
    aoa.push(headers.map((h) => row[h] ?? ""));
  }

  const blankRows = Math.max(0, TEMPLATE_ENTRY_ROWS - sheet.exampleRows.length);
  for (let i = 0; i < blankRows; i += 1) {
    aoa.push(new Array(headers.length).fill(""));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws["!cols"] = sheet.columns.map((c) => ({
    wch: columnWidth(
      c.header,
      sheet.exampleRows.map((r) => r[c.header] ?? ""),
    ),
  }));

  // Filter the complete template entry area, not just the example rows.
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: TEMPLATE_ENTRY_ROWS, c: headers.length - 1 },
    }),
  };

  sheet.columns.forEach((col, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
    const parts: string[] = [];
    if (col.required) parts.push("Required.");
    if (col.comment) parts.push(col.comment);
    if (col.choices && col.choices.length > 0) {
      parts.push(`Valid values: ${col.choices.join(", ")}.`);
    }
    if (parts.length > 0) addComment(ws, cellRef, parts.join(" "));
  });

  if (sheet.exampleRows.length > 0) {
    addComment(
      ws,
      XLSX.utils.encode_cell({ r: 1, c: 0 }),
      `Worked example row${sheet.exampleRows.length > 1 ? "s" : ""} — delete before entering your own data.`,
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

/** Base64-encoded .xlsx bytes — usable server-side or in a browser. */
export function lexibiteTemplateBase64(): string {
  const wb = buildLexibiteTemplateWorkbook();
  return XLSX.write(wb, {
    type: "base64",
    bookType: "xlsx",
    cellStyles: true,
  });
}

/** Browser-only: builds the workbook and triggers a file download. */
export function downloadLexibiteTemplate(filename: string = LEXIBITE_TEMPLATE_FILENAME): void {
  const wb = buildLexibiteTemplateWorkbook();
  XLSX.writeFile(wb, filename, { cellStyles: true });
}
