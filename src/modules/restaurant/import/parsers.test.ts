import { describe, expect, it } from "vitest";
import { parseCsv, parseJson, parsePasted, parseXlsxBase64 } from "./parsers";
import * as XLSX from "xlsx";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const csv = "Item Name,SKU,Qty\nRice,ITM-1,10\nBeef,ITM-2,5\n";
    const { sheets } = parseCsv(csv);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.headers).toEqual(["Item Name", "SKU", "Qty"]);
    expect(sheets[0]!.rows).toEqual([
      { "Item Name": "Rice", SKU: "ITM-1", Qty: "10" },
      { "Item Name": "Beef", SKU: "ITM-2", Qty: "5" },
    ]);
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const csv = 'Name,Notes\n"Coca-Cola, 500ml","Chilled, ""fresh"" stock"\n';
    const { sheets } = parseCsv(csv);
    expect(sheets[0]!.rows[0]).toEqual({
      Name: "Coca-Cola, 500ml",
      Notes: 'Chilled, "fresh" stock',
    });
  });

  it("returns no rows for a header-only file", () => {
    const { sheets } = parseCsv("Name,SKU\n");
    expect(sheets[0]!.rows).toEqual([]);
  });
});

describe("parsePasted", () => {
  it("detects tab-delimited paste from a spreadsheet", () => {
    const pasted = "Name\tSKU\tQty\nRice\tITM-1\t10\n";
    const { sheets } = parsePasted(pasted);
    expect(sheets[0]!.rows).toEqual([{ Name: "Rice", SKU: "ITM-1", Qty: "10" }]);
  });

  it("falls back to comma when there are no tabs", () => {
    const pasted = "Name,SKU\nRice,ITM-1\n";
    const { sheets } = parsePasted(pasted);
    expect(sheets[0]!.rows).toEqual([{ Name: "Rice", SKU: "ITM-1" }]);
  });
});

describe("parseJson", () => {
  it("accepts a plain array of rows", () => {
    const { sheets } = parseJson(JSON.stringify([{ name: "Rice", qty: 10 }]));
    expect(sheets[0]!.rows).toEqual([{ name: "Rice", qty: "10" }]);
  });

  it("accepts an object of named row arrays as multiple sheets", () => {
    const { sheets } = parseJson(
      JSON.stringify({
        inventory: [{ name: "Rice" }],
        suppliers: [{ name: "ACME Foods" }],
      }),
    );
    expect(sheets.map((s) => s.sheetName).sort()).toEqual(["inventory", "suppliers"]);
  });

  it("throws rather than guessing at an unrecognised shape", () => {
    expect(() => parseJson(JSON.stringify({ nope: "not an array" }))).toThrow();
  });
});

describe("parseXlsxBase64", () => {
  it("parses a workbook built with the same xlsx dependency", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Item Name", "SKU", "Qty"],
      ["Rice", "ITM-1", 10],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Inventory");
    const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });

    const { sheets } = parseXlsxBase64(base64);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.sheetName).toBe("Inventory");
    expect(sheets[0]!.rows[0]).toEqual({ "Item Name": "Rice", SKU: "ITM-1", Qty: "10" });
  });

  it("skips sheets with no header row", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Empty");
    const ws = XLSX.utils.aoa_to_sheet([["Name"], ["Rice"]]);
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });

    const { sheets } = parseXlsxBase64(base64);
    expect(sheets.map((s) => s.sheetName)).toEqual(["Data"]);
  });
});
