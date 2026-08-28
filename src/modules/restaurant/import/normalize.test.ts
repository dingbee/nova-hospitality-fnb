import { describe, expect, it } from "vitest";
import { applyMapping, parseBoolean, parseNumber, resolveUnit } from "./normalize";
import type { UnitRow } from "../inventory/units";

describe("applyMapping", () => {
  it("maps a raw row through a saved column mapping, dropping unmapped columns", () => {
    const mapped = applyMapping(
      [
        { sourceColumn: "Item Name", canonicalField: "name", confidence: 1, auto: true },
        { sourceColumn: "Some Other Column", canonicalField: null, confidence: 0, auto: false },
      ],
      { "Item Name": "Rice", "Some Other Column": "ignore me" },
    );
    expect(mapped).toEqual({ name: "Rice" });
  });

  it("skips empty values rather than mapping blanks", () => {
    const mapped = applyMapping(
      [{ sourceColumn: "SKU", canonicalField: "sku", confidence: 1, auto: true }],
      { SKU: "" },
    );
    expect(mapped).toEqual({});
  });
});

describe("parseNumber", () => {
  it("parses plain and thousands-separated numbers", () => {
    expect(parseNumber("10")).toBe(10);
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber(" 12 ")).toBe(12);
  });

  it("returns null for blank or unparsable input, never a guess", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber("12kg")).toBeNull();
    expect(parseNumber("about 10")).toBeNull();
  });
});

describe("parseBoolean", () => {
  it("recognises common truthy/falsy words", () => {
    expect(parseBoolean("Yes")).toBe(true);
    expect(parseBoolean("Available")).toBe(true);
    expect(parseBoolean("No")).toBe(false);
    expect(parseBoolean("Out of Stock")).toBe(false);
  });

  it("returns null rather than guessing for unrecognised text", () => {
    expect(parseBoolean("maybe")).toBeNull();
    expect(parseBoolean("")).toBeNull();
  });
});

describe("resolveUnit", () => {
  const units: UnitRow[] = [
    { id: "u-kg", code: "kg", name: "Kilogram", dimension: "mass", factor: 1000 },
    { id: "u-g", code: "g", name: "Gram", dimension: "mass", factor: 1 },
    { id: "u-carton", code: "CARTON-24", name: "Carton of 24", dimension: "count", factor: 1 },
  ];

  it("resolves a known alias to the tenant's unit row", () => {
    expect(resolveUnit("Kilograms", units).unit?.id).toBe("u-kg");
    expect(resolveUnit("KG", units).unit?.id).toBe("u-kg");
  });

  it("resolves a raw label that already matches a unit code exactly", () => {
    expect(resolveUnit("CARTON-24", units).unit?.id).toBe("u-carton");
  });

  it("reports unknown rather than guessing for an unfamiliar label", () => {
    const result = resolveUnit("sacks", units);
    expect(result.status).toBe("unknown");
    expect(result.unit).toBeNull();
    expect(result.raw).toBe("sacks");
  });

  it("reports unknown for a blank label", () => {
    expect(resolveUnit("", units).status).toBe("unknown");
    expect(resolveUnit(undefined, units).status).toBe("unknown");
  });
});
