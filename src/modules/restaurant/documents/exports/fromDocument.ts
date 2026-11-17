/**
 * Adapts a rendered document into the export model, so "Print" and
 * "Download XLSX" of the same purchase order show the same numbers. No value
 * is recalculated here — the tables are copied verbatim.
 */
import { fileStem } from "../core/format";
import type { RestaurantDocument } from "../core/types";
import type { ExportSheet, ExportWorkbook } from "./model";

export function documentToWorkbook(doc: RestaurantDocument): ExportWorkbook {
  const sheets: ExportSheet[] = doc.tables.map((table, i) => ({
    name: table.title ?? `Lines ${i + 1}`,
    columns: table.columns,
    rows: table.totalsRow ? [...table.rows, table.totalsRow] : table.rows,
  }));

  if (doc.totals.length) {
    sheets.push({
      name: "Totals",
      columns: [
        { key: "label", label: "Label" },
        { key: "value", label: "Value", format: "money" },
        { key: "currency", label: "Currency" },
        { key: "available", label: "Available" },
      ],
      rows: doc.totals.map((t) => ({
        label: t.label,
        value: t.unavailable ? null : t.value,
        currency: t.currency ?? doc.currency ?? "",
        available: t.unavailable ? "NOT AVAILABLE" : "YES",
      })),
    });
  }

  if (doc.traceability.length) {
    sheets.push({
      name: "Traceability",
      columns: [
        { key: "label", label: "Label" },
        { key: "recordType", label: "Record Type" },
        { key: "recordNumber", label: "Record Number" },
        { key: "recordId", label: "Record ID" },
      ],
      rows: doc.traceability.map((t) => ({ ...t })),
    });
  }

  if (doc.audit.length) {
    sheets.push({
      name: "Audit",
      columns: [
        { key: "action", label: "Action" },
        { key: "at", label: "At", format: "datetime" },
        { key: "actorName", label: "Actor" },
        { key: "format", label: "Format" },
      ],
      rows: doc.audit.map((a) => ({
        action: a.action,
        at: a.at,
        actorName: a.actorName ?? a.actorId ?? "",
        format: a.format ?? "",
      })),
    });
  }

  return {
    type: doc.type,
    title: doc.title,
    fileStem: fileStem([doc.number ?? doc.type, doc.generatedAt.slice(0, 10)]),
    metadata: {
      generatedAt: doc.generatedAt,
      tenant: doc.header.business,
      property: doc.header.property ?? null,
      outlet: doc.header.outlet ?? null,
      source: doc.type,
      filters: {
        "Document Number": doc.number ?? "",
        Status: doc.status ?? "",
        Snapshot: doc.snapshot ? "frozen at issuance" : "live data",
      },
      rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
    },
    sheets,
  };
}