import { describe, expect, it } from "vitest";
import { displayValue, fileStem, isoDate, machineValue } from "./core/format";
import { DOCUMENT_TYPE_LIST, NUMBER_PREFIX_TO_TYPE, documentType } from "./core/registry";
import { workbookToCsv } from "./exports/csv";
import { documentToWorkbook } from "./exports/fromDocument";
import { metadataMatrix, sheetMatrix } from "./exports/model";
import { documentToHtml } from "./rendering/toHtml";
import type { RestaurantDocument } from "./core/types";

const doc: RestaurantDocument = {
  type: "purchase_order",
  title: "Purchase Order",
  number: "PO-2026-000142",
  status: "ISSUED",
  currency: "TZS",
  issuedAt: "2026-02-01",
  generatedAt: "2026-02-02T08:00:00Z",
  header: { business: "Riverbend Hospitality Group", property: "Riverbend Lodge", outlet: "Main Bar" },
  parties: [{ label: "Supplier", value: "Kilimanjaro Foods", emphasis: true }],
  meta: [{ label: "Order date", value: "2026-02-01" }],
  tables: [
    {
      title: "Ordered lines",
      columns: [
        { key: "description", label: "Description" },
        { key: "quantity", label: "Ordered", format: "number" },
        { key: "line_total", label: "Line Total", format: "money" },
      ],
      rows: [
        { description: 'Tomatoes, "grade A"', quantity: 12.5, line_total: 25000 },
        { description: "Onions\nred", quantity: 4, line_total: 8000 },
      ],
      totalsRow: { description: "Total", quantity: null, line_total: 33000 },
    },
  ],
  totals: [{ label: "Order total", value: 33000, currency: "TZS", emphasis: true }],
  signatures: ["Prepared by"],
  notes: null,
  traceability: [{ label: "Purchase order", recordType: "restaurant_purchase_orders", recordId: "abc", recordNumber: "PO-2026-000142" }],
  audit: [{ action: "printed", at: "2026-02-02T09:00:00Z", format: "print" }],
  snapshot: false,
};

describe("document formatting", () => {
  it("keeps spreadsheet values machine readable", () => {
    expect(machineValue("12.50", "money")).toBe(12.5);
    expect(machineValue("2026-02-01T10:00:00Z", "date")).toBe("2026-02-01");
    expect(machineValue(null, "number")).toBe("");
  });

  it("formats human output only for printed documents", () => {
    expect(displayValue(1234.5, "money", "TZS")).toBe("TZS 1,234.50");
    expect(displayValue(null, "money")).toBe("—");
    expect(isoDate("")).toBe("");
  });

  it("produces filesystem-safe file names", () => {
    expect(fileStem(["PO-2026/000142", "2026-02-01"])).toBe("PO-2026-000142-2026-02-01");
  });
});

describe("document registry", () => {
  it("gives every type a capability, a group and at least one format", () => {
    for (const d of DOCUMENT_TYPE_LIST) {
      expect(d.capability).toBeTruthy();
      expect(d.group).toBeTruthy();
      expect(d.formats.length).toBeGreaterThan(0);
    }
  });

  it("maps number prefixes back to their document type", () => {
    expect(NUMBER_PREFIX_TO_TYPE.PO).toBe("purchase_order");
    expect(documentType("goods_receipt")?.numberPrefix).toBe("GRN");
  });
});

describe("document to workbook", () => {
  const wb = documentToWorkbook(doc);

  it("carries the totals row into the data sheet so print and export agree", () => {
    expect(wb.sheets[0].rows).toHaveLength(3);
    expect(wb.sheets[0].rows[2].line_total).toBe(33000);
  });

  it("keeps totals, traceability and audit on their own sheets", () => {
    expect(wb.sheets.map((s) => s.name)).toContain("Totals");
    expect(wb.sheets.map((s) => s.name)).toContain("Traceability");
    expect(wb.sheets.map((s) => s.name)).toContain("Audit");
  });

  it("records the period and source on the metadata sheet", () => {
    const rows = metadataMatrix(wb.metadata).map((r) => r[0]);
    expect(rows).toContain("Generated At");
    expect(rows).toContain("Filter: Document Number");
  });
});

describe("csv export", () => {
  it("escapes quotes and newlines per RFC 4180", () => {
    const csv = workbookToCsv(documentToWorkbook(doc));
    expect(csv).toContain('"Tomatoes, ""grade A"""');
    expect(csv).toContain('"Onions\nred"');
  });

  it("emits header row first for each sheet", () => {
    const matrix = sheetMatrix(documentToWorkbook(doc).sheets[0]);
    expect(matrix[0]).toEqual(["Description", "Ordered", "Line Total"]);
  });
});

describe("printed html", () => {
  const html = documentToHtml(doc);

  it("states the document number, status and business", () => {
    expect(html).toContain("PO-2026-000142");
    expect(html).toContain("ISSUED");
    expect(html).toContain("Riverbend Hospitality Group");
  });

  it("escapes user data instead of injecting markup", () => {
    const risky = documentToHtml({ ...doc, notes: "<script>alert(1)</script>" });
    expect(risky).not.toContain("<script>alert(1)</script>");
    expect(risky).toContain("&lt;script&gt;");
  });

  it("declares whether the output is frozen at issuance", () => {
    expect(html).toContain("Rendered from current operational data.");
    expect(documentToHtml({ ...doc, snapshot: true })).toContain("stored snapshot");
  });
});
describe("requisition document registration", () => {
  it("is a first-class registered document, not a bespoke print", () => {
    const type = documentType("requisition");
    expect(type).toBeDefined();
    if (!type) throw new Error("requisition document type is not registered");
    expect(type.group).toBe("inventory");
    expect(type.numberPrefix).toBe("REQ");
    // Same formats as every other governed document: the Centre gets view,
    // print, PDF and export for free precisely because nothing is bespoke.
    expect(type.formats.length).toBeGreaterThan(0);
    expect(type.capability).toBe("requisition.create");
  });
});
