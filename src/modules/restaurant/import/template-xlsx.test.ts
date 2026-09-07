import { describe, expect, it } from "vitest";
import { buildLexibiteTemplateWorkbook, lexibiteTemplateBase64 } from "./template-xlsx";
import {
  detectLexibiteTemplate,
  LEXIBITE_TEMPLATE_SHEETS,
  LEXIBITE_TEMPLATE_VERSION,
} from "./template";
import { parseXlsxBase64 } from "./parsers";
import * as XLSX from "xlsx";

describe("LexiBite template workbook generation", () => {
  it("produces a real workbook with every sheet in the canonical order, plus a hidden metadata sheet", () => {
    const wb = buildLexibiteTemplateWorkbook();
    expect(wb.SheetNames[0]).toBe("START HERE");
    for (let i = 0; i < LEXIBITE_TEMPLATE_SHEETS.length; i++) {
      expect(wb.SheetNames[i + 1]).toBe(LEXIBITE_TEMPLATE_SHEETS[i]!.name);
    }
    expect(wb.SheetNames.at(-1)).toBe("_lexibite_meta");
    const metaIndex = wb.SheetNames.indexOf("_lexibite_meta");
    expect(wb.Workbook?.Sheets?.[metaIndex]?.Hidden).toBe(1);
  });

  it("writes real headers for every operational sheet, with no internal UUID-shaped fields exposed", () => {
    const wb = buildLexibiteTemplateWorkbook();
    for (const sheet of LEXIBITE_TEMPLATE_SHEETS) {
      const ws = wb.Sheets[sheet.name]!;
      const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
      expect(rows[0]).toEqual(sheet.columns.map((c) => c.header));
      for (const header of rows[0] ?? []) {
        expect(header.toLowerCase()).not.toContain("uuid");
        expect(header.toLowerCase()).not.toMatch(/\bid\b/);
      }
    }
  });

  it("includes example rows, distinct from the header row", () => {
    const wb = buildLexibiteTemplateWorkbook();
    const inventorySheet = wb.Sheets["INVENTORY"]!;
    const rows: string[][] = XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: false });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1]?.[0]).toBe("CHICK-001");
  });

  it("carries the version marker somewhere in the workbook text", () => {
    const wb = buildLexibiteTemplateWorkbook();
    const startHere = wb.Sheets["START HERE"]!;
    const rows: string[][] = XLSX.utils.sheet_to_json(startHere, { header: 1, raw: false });
    const flat = rows.flat().join(" | ");
    expect(flat).toContain("LexiBite Template");
    expect(flat).toContain(`Template Version: ${LEXIBITE_TEMPLATE_VERSION}`);
  });

  it("round-trips through base64 -> parseXlsxBase64 and is recognised by detectLexibiteTemplate", () => {
    const base64 = lexibiteTemplateBase64();
    const parsed = parseXlsxBase64(base64);
    expect(parsed.sheets.length).toBeGreaterThan(0);
    const detection = detectLexibiteTemplate(parsed.sheets);
    expect(detection.isTemplate).toBe(true);
    expect(detection.markerFound).toBe(true);
    expect(detection.version).toBe(LEXIBITE_TEMPLATE_VERSION);
    expect(detection.missingRequiredSheetNames).toEqual([]);
  });

  it("is still recognised structurally even if the marker text is stripped (customer deleted START HERE)", () => {
    const base64 = lexibiteTemplateBase64();
    const parsed = parseXlsxBase64(base64);
    const withoutStartHere = parsed.sheets.filter(
      (s) => s.sheetName !== "START HERE" && s.sheetName !== "_lexibite_meta",
    );
    const detection = detectLexibiteTemplate(withoutStartHere);
    expect(detection.markerFound).toBe(false);
    expect(detection.isTemplate).toBe(true);
  });

  it("does not recognise an arbitrary unrelated workbook as a LexiBite template", () => {
    const detection = detectLexibiteTemplate([
      { sheetName: "Sheet1", headers: ["Foo", "Bar"], rows: [{ Foo: "a", Bar: "b" }] },
    ]);
    expect(detection.isTemplate).toBe(false);
  });
});
