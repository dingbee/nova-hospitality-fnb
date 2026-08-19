/**
 * Sprint 5.9 — Document layer types.
 *
 * Browser-safe. A `RestaurantDocument` is a *rendered view* of authoritative
 * data: every number inside it was produced by the owning service (pricing
 * engine, POS, invoice matcher, stock ledger). The document layer never
 * recomputes a total — it only labels, orders and formats facts.
 */

export type DocFormat = "print" | "pdf" | "csv" | "xlsx" | "json";

export type CellValue = string | number | boolean | null;

export type ColumnFormat = "text" | "integer" | "number" | "money" | "date" | "datetime" | "percent";

export interface DocumentColumn {
  key: string;
  label: string;
  format?: ColumnFormat;
  align?: "left" | "right" | "center";
  /** Currency code for `money` columns when it is not the document currency. */
  currency?: string;
}

export interface DocumentTable {
  title?: string;
  columns: DocumentColumn[];
  rows: Record<string, CellValue>[];
  /** Rendered as a bold trailing row. Keys must match column keys. */
  totalsRow?: Record<string, CellValue> | null;
  note?: string | null;
  /** Rendered as an indented tree using this key's depth value. */
  depthKey?: string;
}

export interface DocumentField {
  label: string;
  value: CellValue;
  /** Marks a field the reader must not miss (variances, mismatches). */
  emphasis?: boolean;
}

export interface DocumentTotal {
  label: string;
  value: number;
  currency?: string | null;
  emphasis?: boolean;
  /** Set when the underlying system genuinely has no value for this line. */
  unavailable?: boolean;
}

export interface DocumentTrace {
  label: string;
  recordType: string;
  recordId?: string | null;
  recordNumber?: string | null;
}

export interface DocumentAuditEntry {
  action: string;
  at: string;
  actorId?: string | null;
  actorName?: string | null;
  format?: string | null;
}

export interface DocumentHeader {
  business: string;
  property?: string | null;
  outlet?: string | null;
  address?: string | null;
  contact?: string | null;
}

export interface RestaurantDocument {
  type: string;
  title: string;
  /** Server-issued document number. `null` only when the record predates numbering. */
  number: string | null;
  status: string | null;
  currency: string | null;
  issuedAt: string | null;
  generatedAt: string;
  header: DocumentHeader;
  /** Supplier / customer / counterparty block. */
  parties: DocumentField[];
  /** Document meta block (dates, references, locations). */
  meta: DocumentField[];
  tables: DocumentTable[];
  totals: DocumentTotal[];
  signatures: string[];
  notes?: string | null;
  /** Chain of evidence back to the operational records. */
  traceability: DocumentTrace[];
  audit: DocumentAuditEntry[];
  /**
   * True when every fact came from stored, immutable columns on the record
   * itself, so re-rendering it tomorrow cannot change it.
   */
  snapshot: boolean;
  /** Explains what is and is not frozen, shown in the document footer. */
  snapshotNote?: string | null;
}