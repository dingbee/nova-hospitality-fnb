/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Global document search. Finding a document must never require knowing which
 * module produced it, so this searches every numbered record across
 * procurement, inventory and sales by number and returns a uniform result.
 */
import { assertTenantRead } from "../core/access.server";
import { documentType, type DocumentGroup, type DocumentTypeId } from "./core/registry";

type Sb = any;

export interface DocumentSearchResult {
  type: DocumentTypeId;
  label: string;
  group: DocumentGroup;
  recordId: string;
  number: string | null;
  status: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
}

interface SourceSpec {
  type: DocumentTypeId;
  table: string;
  numberColumn: string;
  dateColumn: string;
  amountColumn?: string;
  select: string;
}

const SOURCES: SourceSpec[] = [
  {
    type: "purchase_order",
    table: "restaurant_purchase_orders",
    numberColumn: "document_number",
    dateColumn: "order_date",
    amountColumn: "total",
    select: "id, document_number, status, order_date, total, currency",
  },
  {
    type: "goods_receipt",
    table: "restaurant_goods_receipts",
    numberColumn: "document_number",
    dateColumn: "received_at",
    amountColumn: "accepted_value",
    select: "id, document_number, status, received_at, accepted_value, currency",
  },
  {
    type: "supplier_invoice",
    table: "restaurant_supplier_invoices",
    numberColumn: "document_number",
    dateColumn: "invoice_date",
    amountColumn: "total",
    select: "id, document_number, status, invoice_date, total, currency",
  },
  {
    type: "requisition",
    table: "restaurant_requisitions",
    numberColumn: "reference",
    dateColumn: "created_at",
    select: "id, reference, status, created_at",
  },
  {
    type: "stock_transfer",
    table: "restaurant_stock_transfers",
    numberColumn: "transfer_number",
    dateColumn: "requested_at",
    amountColumn: "total_value",
    select: "id, transfer_number, status, requested_at, total_value, currency",
  },
  {
    type: "stocktake_sheet",
    table: "restaurant_stocktakes",
    numberColumn: "stocktake_number",
    dateColumn: "started_at",
    amountColumn: "variance_value",
    select: "id, stocktake_number, status, started_at, variance_value, currency",
  },
  {
    type: "customer_receipt",
    table: "restaurant_receipts",
    numberColumn: "receipt_number",
    dateColumn: "issued_at",
    amountColumn: "total",
    select: "id, receipt_number, issued_at, total, currency",
  },
];

export async function searchDocuments(
  sb: Sb,
  userId: string,
  input: { tenantId: string; query: string; group?: DocumentGroup; limit: number },
): Promise<DocumentSearchResult[]> {
  await assertTenantRead(sb, userId, input.tenantId);
  const term = input.query.trim();
  const perSource = Math.max(5, Math.ceil(input.limit / SOURCES.length));

  const sources = SOURCES.filter((s) => !input.group || documentType(s.type)?.group === input.group);

  const results = await Promise.all(
    sources.map(async (s) => {
      let q = sb
        .from(s.table)
        .select(s.select)
        .eq("tenant_id", input.tenantId)
        .order(s.dateColumn, { ascending: false })
        .limit(perSource);
      if (term) q = q.ilike(s.numberColumn, `%${term}%`);
      const { data, error } = await q;
      // A single unreadable source (RLS, missing column) must not blank the
      // whole search — the other sources still answer.
      if (error) return [] as DocumentSearchResult[];
      const def = documentType(s.type)!;
      return ((data ?? []) as any[]).map((r) => ({
        type: s.type,
        label: def.label,
        group: def.group,
        recordId: r.id as string,
        number: (r[s.numberColumn] as string) ?? null,
        status: typeof r.status === "string" ? r.status : null,
        date: (r[s.dateColumn] as string) ?? null,
        amount: s.amountColumn && r[s.amountColumn] != null ? Number(r[s.amountColumn]) : null,
        currency: (r.currency as string) ?? null,
      }));
    }),
  );

  return results
    .flat()
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, input.limit);
}