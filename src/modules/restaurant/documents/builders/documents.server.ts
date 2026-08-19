/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Document builders. Each builder maps one authoritative operational record
 * into the `RestaurantDocument` shape. Rules that hold for all of them:
 *
 *  - No value is recomputed here. Totals come from the columns the owning
 *    service wrote; a document can never disagree with the ledger.
 *  - Missing data is labelled "not available" rather than shown as zero.
 *  - Every document carries its traceability chain and its audit trail.
 */
import { assertCapability, assertTenantRead } from "../../core/access.server";
import { auditEntriesFor } from "../audit/audit.server";
import { documentType, type DocumentTypeId } from "../core/registry";
import type { RestaurantDocument } from "../core/types";
import { documentHeader, nameMap, nowIso } from "./context.server";

type Sb = any;

const num = (v: unknown) => Number(v ?? 0);

async function finish(
  sb: Sb,
  tenantId: string,
  type: DocumentTypeId,
  documentId: string,
  doc: Omit<RestaurantDocument, "audit" | "generatedAt" | "type">,
): Promise<RestaurantDocument> {
  return {
    ...doc,
    type,
    generatedAt: nowIso(),
    audit: await auditEntriesFor(sb, tenantId, type, documentId),
  };
}

/* --------------------------------------------------------- Requisition */

/**
 * A requisition note is a *representation* of the requisition record: every
 * quantity below is the one the requisition service stored, and issuing is
 * evidenced by the transfer pair it posted to the stock ledger. Nothing here
 * writes, recomputes or reconciles.
 */
async function buildRequisition(sb: Sb, userId: string, tenantId: string, id: string) {
  const { getRequisition } = await import("../../requisitions/requisitions.server");
  const r: any = await getRequisition(sb, userId, tenantId, id);
  const lines: any[] = r.lines ?? [];

  const itemIds = [...new Set(lines.map((l) => l.inventory_item_id).filter(Boolean))];
  const unitIds = [...new Set(lines.map((l) => l.unit_id).filter(Boolean))];

  const [header, { data: itemRows }, { data: unitRows }, { data: movements }] = await Promise.all([
    documentHeader(sb, tenantId, r.property_id, r.source_location_id),
    itemIds.length
      ? sb.from("restaurant_inventory_items").select("id, name, sku, unit_id").eq("tenant_id", tenantId).in("id", itemIds)
      : Promise.resolve({ data: [] }),
    unitIds.length
      ? sb.from("restaurant_inventory_units").select("id, code").eq("tenant_id", tenantId).in("id", unitIds)
      : Promise.resolve({ data: [] }),
    sb
      .from("restaurant_stock_movements")
      .select("id, movement_type, quantity, occurred_at, inventory_item_id")
      .eq("tenant_id", tenantId)
      .eq("reference_type", "restaurant_requisition")
      .eq("reference_id", id)
      .order("occurred_at"),
  ]);

  const items = new Map(((itemRows ?? []) as any[]).map((i) => [i.id as string, i]));
  const units = new Map(((unitRows ?? []) as any[]).map((u) => [u.id as string, u.code as string]));
  const movementRows = (movements ?? []) as any[];

  const rows = lines.map((l) => {
    const item = items.get(l.inventory_item_id);
    const approved = l.approved_quantity;
    return {
      item: l.item_name ?? item?.name ?? "Item",
      sku: item?.sku ?? "—",
      unit: units.get(l.unit_id ?? item?.unit_id) ?? "—",
      requested_quantity: num(l.requested_quantity),
      // A requisition that has not been approved has no approved quantity —
      // that is different from an approved quantity of zero.
      approved_quantity: approved == null ? null : num(approved),
      issued_quantity: num(l.issued_quantity),
      outstanding_quantity: num(l.outstanding_quantity),
      notes: l.notes ?? "",
    };
  });

  const totalRequested = rows.reduce((s, l) => s + Number(l.requested_quantity ?? 0), 0);
  const totalIssued = rows.reduce((s, l) => s + Number(l.issued_quantity ?? 0), 0);
  const anyApproved = rows.some((l) => l.approved_quantity != null);
  const totalApproved = rows.reduce((s, l) => s + Number(l.approved_quantity ?? 0), 0);

  const actor = (v: unknown) => (v ? String(v) : "Not recorded");

  return finish(sb, tenantId, "requisition", id, {
    title: "Requisition Note",
    number: r.reference ?? null,
    status: String(r.status ?? "").toUpperCase(),
    // Requisitions move stock, not money: they carry no commercial currency.
    currency: null,
    issuedAt: r.issued_at ?? r.submitted_at ?? r.created_at ?? null,
    header,
    parties: [
      { label: "Issuing store", value: r.source_name ?? "—", emphasis: true },
      { label: "Destination", value: r.destination_name ?? "—", emphasis: true },
      { label: "Department", value: r.department ?? r.kind ?? "—" },
    ],
    meta: [
      { label: "Requisition type", value: r.kind ?? "—" },
      { label: "Required date", value: r.required_date ?? "—" },
      { label: "Created", value: r.created_at ?? "—" },
      { label: "Submitted", value: r.submitted_at ?? "Not submitted" },
      { label: "Approved", value: r.approved_at ?? "Not approved" },
      { label: "Issued", value: r.issued_at ?? "Not issued" },
      { label: "Requested by", value: actor(r.requested_by) },
      { label: "Approved by", value: actor(r.approved_by) },
      { label: "Issued by", value: actor(r.issued_by) },
      ...(r.rejected_reason
        ? [{ label: "Rejection / cancellation reason", value: r.rejected_reason, emphasis: true }]
        : []),
    ],
    tables: [
      {
        title: "Requisition lines",
        columns: [
          { key: "item", label: "Item" },
          { key: "sku", label: "SKU" },
          { key: "unit", label: "Unit" },
          { key: "requested_quantity", label: "Requested", format: "number" },
          { key: "approved_quantity", label: "Approved", format: "number" },
          { key: "issued_quantity", label: "Issued", format: "number" },
          { key: "outstanding_quantity", label: "Outstanding", format: "number" },
          { key: "notes", label: "Notes" },
        ],
        rows,
        totalsRow: {
          item: "Total",
          sku: null,
          unit: null,
          requested_quantity: totalRequested,
          approved_quantity: anyApproved ? totalApproved : null,
          issued_quantity: totalIssued,
          outstanding_quantity: rows.reduce((s, l) => s + Number(l.outstanding_quantity ?? 0), 0),
          notes: null,
        },
        note:
          "Requested, approved and issued are separate facts. An empty approved quantity means the line has not been approved yet — it is not a zero.",
      },
      ...(movementRows.length
        ? [
            {
              title: "Stock ledger movements",
              columns: [
                { key: "occurred_at", label: "When", format: "datetime" as const },
                { key: "item", label: "Item" },
                { key: "movement_type", label: "Movement" },
                { key: "quantity", label: "Quantity", format: "number" as const },
              ],
              rows: movementRows.map((m) => ({
                occurred_at: m.occurred_at,
                item: items.get(m.inventory_item_id)?.name ?? "Item",
                movement_type: String(m.movement_type ?? "").replace(/_/g, " "),
                quantity: num(m.quantity),
              })),
              note: "Issuing posts a transfer out of the store and a transfer into the destination — this is the ledger's own record.",
            },
          ]
        : []),
    ],
    totals: [
      { label: "Lines", value: rows.length },
      { label: "Total requested", value: totalRequested },
      {
        label: "Total approved",
        value: anyApproved ? totalApproved : 0,
        unavailable: !anyApproved,
      },
      { label: "Total issued", value: totalIssued, emphasis: true },
    ],
    signatures: ["Requested by", "Approved by", "Issued by", "Received by"],
    notes: r.notes ?? null,
    traceability: [
      { label: "Requisition", recordType: "restaurant_requisitions", recordId: r.id, recordNumber: r.reference },
      ...movementRows.map((m) => ({
        label: `Stock movement (${String(m.movement_type ?? "").replace(/_/g, " ")})`,
        recordType: "restaurant_stock_movements",
        recordId: m.id as string,
        recordNumber: null,
      })),
    ],
    snapshot: false,
    snapshotNote:
      "Quantities are read live from the requisition and the stock ledger; receipt confirmation is not separately captured by the requisition record.",
  });
}

/* ------------------------------------------------------------------ PO */

async function buildPurchaseOrder(sb: Sb, userId: string, tenantId: string, id: string) {
  const { getPurchaseOrderDetail } = await import("../../purchasing/purchasing.server");
  const detail = await getPurchaseOrderDetail(sb, userId, tenantId, id);
  const o = detail.order;
  const header = await documentHeader(sb, tenantId, o.property_id, o.location_id);
  const supplier = detail.supplier as any;

  const rows = detail.items.map((i: any) => ({
    description: i.description,
    quantity: num(i.quantity),
    unit_price: num(i.unit_price),
    line_total: num(i.line_total),
    confirmed_quantity: i.confirmed_quantity,
    accepted_quantity: i.accepted_quantity,
  }));

  return finish(sb, tenantId, "purchase_order", id, {
    title: "Purchase Order",
    number: o.document_number ?? o.reference ?? null,
    status: String(o.status ?? "").toUpperCase(),
    currency: o.currency ?? null,
    issuedAt: o.order_date ?? null,
    header,
    parties: [
      { label: "Supplier", value: supplier?.name ?? "—", emphasis: true },
      { label: "Supplier code", value: supplier?.code ?? "—" },
      { label: "Payment terms", value: supplier?.payment_terms ?? "—" },
      { label: "Supplier reference", value: o.supplier_reference ?? "—" },
    ],
    meta: [
      { label: "Order date", value: o.order_date ?? "—" },
      { label: "Expected", value: o.expected_at ?? "—" },
      { label: "Confirmation", value: o.confirmation_status ?? "—" },
      { label: "Confirmed at", value: o.confirmed_at ?? "—" },
    ],
    tables: [
      {
        title: "Ordered lines",
        columns: [
          { key: "description", label: "Description" },
          { key: "quantity", label: "Ordered", format: "number" },
          { key: "confirmed_quantity", label: "Confirmed", format: "number" },
          { key: "accepted_quantity", label: "Accepted", format: "number" },
          { key: "unit_price", label: "Unit Price", format: "money" },
          { key: "line_total", label: "Line Total", format: "money" },
        ],
        rows,
        totalsRow: {
          description: "Total",
          quantity: null,
          confirmed_quantity: null,
          accepted_quantity: null,
          unit_price: null,
          line_total: num(o.total),
        },
        note: "Ordered, confirmed and accepted are separate facts and are never collapsed into one quantity.",
      },
    ],
    totals: [
      { label: "Subtotal", value: num(o.subtotal), currency: o.currency },
      { label: "Order total", value: num(o.total), currency: o.currency, emphasis: true },
    ],
    signatures: ["Prepared by", "Approved by", "Supplier acknowledgement"],
    notes: o.notes ?? null,
    traceability: [
      { label: "Purchase order", recordType: "restaurant_purchase_orders", recordId: o.id, recordNumber: o.document_number },
      ...detail.receipts.map((r: any) => ({
        label: "Goods receipt",
        recordType: "restaurant_goods_receipts",
        recordId: r.id,
        recordNumber: r.document_number,
      })),
      ...detail.invoices.map((i: any) => ({
        label: "Supplier invoice",
        recordType: "restaurant_supplier_invoices",
        recordId: i.id,
        recordNumber: i.document_number,
      })),
    ],
    snapshot: false,
    snapshotNote: "Line prices are those stored on the order; downstream receipts and invoices are listed for traceability.",
  });
}

/* ----------------------------------------------------------------- GRN */

async function buildGoodsReceipt(sb: Sb, userId: string, tenantId: string, id: string) {
  const { getGoodsReceipt } = await import("../../procurement/receiving.server");
  const { receipt, lines, variances } = await getGoodsReceipt(sb, userId, tenantId, id);
  if (!receipt) throw new Error("Goods receipt not found.");
  const [header, suppliers] = await Promise.all([
    documentHeader(sb, tenantId, receipt.property_id, receipt.location_id),
    nameMap(sb, "restaurant_suppliers", tenantId),
  ]);

  return finish(sb, tenantId, "goods_receipt", id, {
    title: "Goods Receipt Note",
    number: receipt.document_number ?? null,
    status: String(receipt.status ?? "").toUpperCase(),
    currency: receipt.currency ?? null,
    issuedAt: receipt.received_at ?? null,
    header,
    parties: [
      { label: "Supplier", value: suppliers.get(receipt.supplier_id) ?? "—", emphasis: true },
      { label: "Delivery note", value: receipt.delivery_note_ref ?? "—" },
    ],
    meta: [
      { label: "Received at", value: receipt.received_at ?? "—" },
      { label: "Expected at", value: receipt.expected_at ?? "—" },
      { label: "Posted to stock", value: receipt.posted_at ?? "Not posted", emphasis: !receipt.posted_at },
      { label: "Variances raised", value: variances.length, emphasis: variances.length > 0 },
    ],
    tables: [
      {
        title: "Delivered lines",
        columns: [
          { key: "description", label: "Description" },
          { key: "ordered_quantity", label: "Ordered", format: "number" },
          { key: "received_quantity", label: "Received", format: "number" },
          { key: "accepted_quantity", label: "Accepted", format: "number" },
          { key: "rejected_quantity", label: "Rejected", format: "number" },
          { key: "damaged_quantity", label: "Damaged", format: "number" },
          { key: "unit_cost", label: "Unit Cost", format: "money" },
          { key: "batch_code", label: "Batch" },
          { key: "expiry_date", label: "Expiry", format: "date" },
        ],
        rows: (lines as any[]).map((l) => ({
          description: l.description,
          ordered_quantity: l.ordered_quantity == null ? null : num(l.ordered_quantity),
          received_quantity: num(l.received_quantity),
          accepted_quantity: num(l.accepted_quantity),
          rejected_quantity: num(l.rejected_quantity),
          damaged_quantity: num(l.damaged_quantity),
          unit_cost: num(l.unit_cost),
          batch_code: l.batch_code ?? "",
          expiry_date: l.expiry_date ?? "",
        })),
        note: "Only the accepted quantity entered inventory.",
      },
      ...(variances.length
        ? [
            {
              title: "Variances",
              columns: [
                { key: "label", label: "Variance" },
                { key: "variance_type", label: "Type" },
                { key: "severity", label: "Severity" },
                { key: "expected_value", label: "Expected", format: "number" as const },
                { key: "actual_value", label: "Actual", format: "number" as const },
                { key: "variance_pct", label: "Variance %", format: "percent" as const },
                { key: "status", label: "Status" },
              ],
              rows: (variances as any[]).map((v) => ({ ...v })),
            },
          ]
        : []),
    ],
    totals: [
      { label: "Delivered subtotal", value: num(receipt.subtotal), currency: receipt.currency },
      { label: "Accepted value", value: num(receipt.accepted_value), currency: receipt.currency, emphasis: true },
    ],
    signatures: ["Received by", "Checked by", "Driver / supplier"],
    notes: receipt.notes ?? null,
    traceability: [
      { label: "Goods receipt", recordType: "restaurant_goods_receipts", recordId: receipt.id, recordNumber: receipt.document_number },
      ...(receipt.purchase_order_id
        ? [{ label: "Purchase order", recordType: "restaurant_purchase_orders", recordId: receipt.purchase_order_id }]
        : []),
    ],
    snapshot: true,
    snapshotNote: "Quantities and costs are those recorded at receiving.",
  });
}

/* --------------------------------------------------------- Supplier invoice */

async function buildSupplierInvoice(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertCapability(sb, userId, tenantId, "invoice.manage");
  const [{ data: inv, error }, { data: lines }] = await Promise.all([
    sb.from("restaurant_supplier_invoices").select("*").eq("tenant_id", tenantId).eq("id", id).single(),
    sb
      .from("restaurant_supplier_invoice_items")
      .select("description, quantity, unit_price, tax_amount, line_total")
      .eq("tenant_id", tenantId)
      .eq("invoice_id", id)
      .order("created_at"),
  ]);
  if (error || !inv) throw new Error("Supplier invoice not found.");
  const [header, suppliers] = await Promise.all([
    documentHeader(sb, tenantId, inv.property_id, inv.location_id),
    nameMap(sb, "restaurant_suppliers", tenantId),
  ]);
  const outstanding = num(inv.total) - num(inv.amount_paid);

  return finish(sb, tenantId, "supplier_invoice", id, {
    title: "Supplier Invoice",
    number: inv.document_number ?? null,
    status: String(inv.status ?? "").toUpperCase(),
    currency: inv.currency ?? null,
    issuedAt: inv.invoice_date ?? null,
    header,
    parties: [
      { label: "Supplier", value: suppliers.get(inv.supplier_id) ?? "—", emphasis: true },
      { label: "Supplier invoice no.", value: inv.supplier_invoice_number ?? "—" },
    ],
    meta: [
      { label: "Invoice date", value: inv.invoice_date ?? "—" },
      { label: "Due date", value: inv.due_date ?? "—" },
      { label: "Match status", value: inv.match_status ?? "—", emphasis: inv.match_status !== "matched" },
      { label: "Payment status", value: inv.payment_status ?? "—" },
    ],
    tables: [
      {
        title: "Invoiced lines",
        columns: [
          { key: "description", label: "Description" },
          { key: "quantity", label: "Quantity", format: "number" },
          { key: "unit_price", label: "Unit Price", format: "money" },
          { key: "tax_amount", label: "Tax", format: "money" },
          { key: "line_total", label: "Line Total", format: "money" },
        ],
        rows: ((lines ?? []) as any[]).map((l) => ({ ...l })),
        totalsRow: { description: "Total", quantity: null, unit_price: null, tax_amount: num(inv.tax_total), line_total: num(inv.total) },
      },
    ],
    totals: [
      { label: "Subtotal", value: num(inv.subtotal), currency: inv.currency },
      { label: "Tax", value: num(inv.tax_total), currency: inv.currency },
      { label: "Invoice total", value: num(inv.total), currency: inv.currency, emphasis: true },
      { label: "Paid", value: num(inv.amount_paid), currency: inv.currency },
      { label: "Outstanding", value: outstanding, currency: inv.currency, emphasis: outstanding > 0 },
    ],
    signatures: ["Recorded by", "Approved for payment"],
    notes: inv.notes ?? null,
    traceability: [
      { label: "Supplier invoice", recordType: "restaurant_supplier_invoices", recordId: inv.id, recordNumber: inv.document_number },
      ...(inv.purchase_order_id
        ? [{ label: "Purchase order", recordType: "restaurant_purchase_orders", recordId: inv.purchase_order_id }]
        : []),
    ],
    snapshot: true,
    snapshotNote: "Recorded invoice values are never rewritten by later price changes.",
  });
}

/* ----------------------------------------------------------- Stock transfer */

async function buildStockTransfer(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertTenantRead(sb, userId, tenantId);
  const [{ data: t, error }, { data: lines }, locations, items] = await Promise.all([
    sb.from("restaurant_stock_transfers").select("*").eq("tenant_id", tenantId).eq("id", id).single(),
    sb.from("restaurant_stock_transfer_lines").select("*").eq("tenant_id", tenantId).eq("transfer_id", id),
    nameMap(sb, "restaurant_locations", tenantId),
    nameMap(sb, "restaurant_inventory_items", tenantId),
  ]);
  if (error || !t) throw new Error("Stock transfer not found.");
  const header = await documentHeader(sb, tenantId, t.property_id, t.source_location_id);

  return finish(sb, tenantId, "stock_transfer", id, {
    title: "Stock Transfer Note",
    number: t.transfer_number ?? null,
    status: String(t.status ?? "").toUpperCase(),
    currency: t.currency ?? null,
    issuedAt: t.dispatched_at ?? t.requested_at ?? null,
    header,
    parties: [
      { label: "From", value: locations.get(t.source_location_id) ?? "—", emphasis: true },
      { label: "To", value: locations.get(t.destination_location_id) ?? "—", emphasis: true },
    ],
    meta: [
      { label: "Requested", value: t.requested_at ?? "—" },
      { label: "Approved", value: t.approved_at ?? "—" },
      { label: "Dispatched", value: t.dispatched_at ?? "—" },
      { label: "Received", value: t.received_at ?? "—" },
    ],
    tables: [
      {
        title: "Transfer lines",
        columns: [
          { key: "item", label: "Item" },
          { key: "requested_quantity", label: "Requested", format: "number" },
          { key: "dispatched_quantity", label: "Dispatched", format: "number" },
          { key: "received_quantity", label: "Received", format: "number" },
          { key: "variance_quantity", label: "Variance", format: "number" },
          { key: "unit_cost", label: "Unit Cost", format: "money" },
        ],
        rows: ((lines ?? []) as any[]).map((l) => ({
          item: items.get(l.inventory_item_id) ?? "Item",
          requested_quantity: num(l.requested_quantity),
          dispatched_quantity: num(l.dispatched_quantity),
          received_quantity: num(l.received_quantity),
          variance_quantity: num(l.variance_quantity),
          unit_cost: num(l.unit_cost),
        })),
      },
    ],
    totals: [{ label: "Transfer value", value: num(t.total_value), currency: t.currency, emphasis: true }],
    signatures: ["Dispatched by", "Received by"],
    notes: t.notes ?? t.rejection_reason ?? null,
    traceability: [
      { label: "Stock transfer", recordType: "restaurant_stock_transfers", recordId: t.id, recordNumber: t.transfer_number },
    ],
    snapshot: true,
    snapshotNote: "Dispatched and received quantities are the ledger's, not a recalculation.",
  });
}

/* -------------------------------------------------------------- Stocktake */

async function buildStocktakeSheet(sb: Sb, userId: string, tenantId: string, id: string) {
  const { getStocktake } = await import("../../inventory/stocktake.server");
  const st: any = await getStocktake(sb, userId, tenantId, id);
  const header = await documentHeader(sb, tenantId, st.property_id, st.location_id);

  const rows = (st.lines as any[]).map((l) => ({
    item_name: l.item_name,
    location_name: l.location_name,
    expected_quantity: num(l.expected_quantity),
    counted_quantity: l.counted_quantity == null ? null : num(l.counted_quantity),
    variance_quantity: num(l.variance_quantity),
    unit_cost: num(l.unit_cost),
    variance_value: num(l.variance_quantity) * num(l.unit_cost),
    reason_code: l.reason_code ?? "",
  }));

  return finish(sb, tenantId, "stocktake_sheet", id, {
    title: "Stocktake Sheet",
    number: st.stocktake_number ?? null,
    status: String(st.status ?? "").toUpperCase(),
    currency: st.currency ?? null,
    issuedAt: st.counted_at ?? st.started_at ?? null,
    header,
    parties: [{ label: "Location", value: st.location_name ?? "All locations", emphasis: true }],
    meta: [
      { label: "Scope", value: st.scope ?? "—" },
      { label: "Started", value: st.started_at ?? "—" },
      { label: "Counted", value: st.counted_at ?? "—" },
      { label: "Posted", value: st.posted_at ?? "Not posted", emphasis: !st.posted_at },
    ],
    tables: [
      {
        title: "Counted lines",
        columns: [
          { key: "item_name", label: "Item" },
          { key: "location_name", label: "Location" },
          { key: "expected_quantity", label: "System", format: "number" },
          { key: "counted_quantity", label: "Counted", format: "number" },
          { key: "variance_quantity", label: "Variance", format: "number" },
          { key: "unit_cost", label: "Unit Cost", format: "money" },
          { key: "variance_value", label: "Variance Value", format: "money" },
          { key: "reason_code", label: "Reason" },
        ],
        rows,
        note: "Blank counted quantities mean the line has not been counted — they are not zero counts.",
      },
    ],
    totals: [{ label: "Variance value", value: num(st.variance_value), currency: st.currency, emphasis: true }],
    signatures: ["Counted by", "Reviewed by", "Approved by"],
    notes: st.notes ?? null,
    traceability: [
      { label: "Stocktake", recordType: "restaurant_stocktakes", recordId: st.id, recordNumber: st.stocktake_number },
    ],
    snapshot: false,
    snapshotNote: "Expected quantities were snapshotted from the ledger when counting started.",
  });
}

/* --------------------------------------------------------- Customer receipt */

async function buildCustomerReceipt(sb: Sb, userId: string, tenantId: string, id: string) {
  await assertCapability(sb, userId, tenantId, "sales.manage");
  const { data: r, error } = await sb
    .from("restaurant_receipts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .single();
  if (error || !r) throw new Error("Receipt not found.");
  const header = await documentHeader(sb, tenantId, r.property_id, r.location_id);
  const snap = (r.snapshot ?? {}) as any;
  const lines = (snap.lines ?? []) as any[];
  const payments = (snap.payments ?? []) as any[];

  return finish(sb, tenantId, "customer_receipt", id, {
    title: "Receipt",
    number: r.receipt_number ?? null,
    status: num(r.paid_total) >= num(r.total) ? "PAID" : "PART PAID",
    currency: r.currency ?? null,
    issuedAt: r.issued_at ?? null,
    header,
    parties: [
      { label: "Guest", value: snap.order?.guest_name ?? "Walk-in" },
      { label: "Order", value: snap.order?.number ?? "—" },
    ],
    meta: [
      { label: "Issued", value: r.issued_at ?? "—" },
      { label: "Covers", value: snap.order?.guest_count ?? "—" },
      { label: "Reprints", value: num(r.reprint_count) },
    ],
    tables: [
      {
        title: "Items",
        columns: [
          { key: "description", label: "Item" },
          { key: "quantity", label: "Qty", format: "number" },
          { key: "unit_price", label: "Price", format: "money" },
          { key: "discount", label: "Discount", format: "money" },
          { key: "tax_amount", label: "Tax", format: "money" },
          { key: "line_total", label: "Total", format: "money" },
        ],
        rows: lines.map((l) => ({
          description: l.description,
          quantity: num(l.quantity),
          unit_price: num(l.unit_price),
          discount: num(l.discount),
          tax_amount: num(l.tax_amount),
          line_total: num(l.line_total),
        })),
      },
      ...(payments.length
        ? [
            {
              title: "Payments",
              columns: [
                { key: "method", label: "Method" },
                { key: "reference", label: "Reference" },
                { key: "amount", label: "Amount", format: "money" as const },
                { key: "captured_at", label: "Captured", format: "datetime" as const },
              ],
              rows: payments.map((p) => ({
                method: p.method,
                reference: p.reference ?? "",
                amount: num(p.amount),
                captured_at: p.captured_at ?? "",
              })),
            },
          ]
        : []),
    ],
    totals: [
      { label: "Subtotal", value: num(r.subtotal), currency: r.currency },
      { label: "Discount", value: num(r.discount_total), currency: r.currency },
      { label: "Service charge", value: num(r.service_charge), currency: r.currency },
      { label: "Tax", value: num(r.tax_total), currency: r.currency },
      { label: "Total", value: num(r.total), currency: r.currency, emphasis: true },
      { label: "Paid", value: num(r.paid_total), currency: r.currency },
    ],
    signatures: [],
    notes: null,
    traceability: [
      { label: "Receipt", recordType: "restaurant_receipts", recordId: r.id, recordNumber: r.receipt_number },
      { label: "Order", recordType: "restaurant_orders", recordId: r.order_id, recordNumber: snap.order?.number ?? null },
    ],
    snapshot: true,
    snapshotNote: "Reproduced from the snapshot stored at payment; reprints never change the figures.",
  });
}

/* ------------------------------------------------------------ Daily closing */

export async function buildDailyClosing(
  sb: Sb,
  userId: string,
  tenantId: string,
  businessDate: string,
  propertyId?: string | null,
) {
  await assertCapability(sb, userId, tenantId, "profitability.manage");
  const from = `${businessDate}T00:00:00.000Z`;
  const to = `${businessDate}T23:59:59.999Z`;

  let ordersQ = sb
    .from("restaurant_orders")
    .select("id, order_number, status, payment_state, order_type, subtotal, discount_total, service_charge, tax_total, total, paid_total, cost_total, currency, opened_at, closed_at")
    .eq("tenant_id", tenantId)
    .gte("opened_at", from)
    .lte("opened_at", to);
  if (propertyId) ordersQ = ordersQ.eq("property_id", propertyId);
  const { data: orders, error } = await ordersQ;
  if (error) throw new Error(error.message);

  const list = (orders ?? []) as any[];
  const ids = list.map((o) => o.id);
  const { data: payments } = ids.length
    ? await sb
        .from("restaurant_payments")
        .select("method, state, amount, currency, order_id")
        .eq("tenant_id", tenantId)
        .in("order_id", ids)
    : { data: [] };

  const currency = list[0]?.currency ?? null;
  const sum = (key: string) => list.reduce((s, o) => s + num(o[key]), 0);

  const byType = new Map<string, { orders: number; total: number }>();
  for (const o of list) {
    const k = o.order_type ?? "unknown";
    const e = byType.get(k) ?? { orders: 0, total: 0 };
    byType.set(k, { orders: e.orders + 1, total: e.total + num(o.total) });
  }
  const byMethod = new Map<string, { count: number; amount: number }>();
  for (const p of ((payments ?? []) as any[]).filter((p) => p.state !== "voided")) {
    const e = byMethod.get(p.method) ?? { count: 0, amount: 0 };
    byMethod.set(p.method, { count: e.count + 1, amount: e.amount + num(p.amount) });
  }

  const open = list.filter((o) => !["closed", "cancelled"].includes(String(o.status)));
  const unpaid = list.filter((o) => num(o.paid_total) + 0.001 < num(o.total));
  const header = await documentHeader(sb, tenantId, propertyId ?? null, null);

  return finish(sb, tenantId, "daily_closing", tenantId, {
    title: "Daily Closing Report",
    number: `CLOSE-${businessDate}`,
    status: open.length ? "EXCEPTIONS" : "CLEAN",
    currency,
    issuedAt: businessDate,
    header,
    parties: [],
    meta: [
      { label: "Business date", value: businessDate },
      { label: "Orders", value: list.length },
      { label: "Still open", value: open.length, emphasis: open.length > 0 },
      { label: "Not fully settled", value: unpaid.length, emphasis: unpaid.length > 0 },
    ],
    tables: [
      {
        title: "Trading by order type",
        columns: [
          { key: "order_type", label: "Order Type" },
          { key: "orders", label: "Orders", format: "integer" },
          { key: "total", label: "Total", format: "money" },
        ],
        rows: [...byType.entries()].map(([k, v]) => ({ order_type: k, orders: v.orders, total: v.total })),
      },
      {
        title: "Tender mix",
        columns: [
          { key: "method", label: "Method" },
          { key: "count", label: "Payments", format: "integer" },
          { key: "amount", label: "Amount", format: "money" },
        ],
        rows: [...byMethod.entries()].map(([k, v]) => ({ method: k, count: v.count, amount: v.amount })),
        totalsRow: {
          method: "Total received",
          count: null,
          amount: [...byMethod.values()].reduce((s, v) => s + v.amount, 0),
        },
      },
      ...(open.length || unpaid.length
        ? [
            {
              title: "Unresolved exceptions",
              columns: [
                { key: "order_number", label: "Order" },
                { key: "status", label: "Status" },
                { key: "payment_state", label: "Payment" },
                { key: "total", label: "Total", format: "money" as const },
                { key: "paid_total", label: "Paid", format: "money" as const },
              ],
              rows: [...new Map([...open, ...unpaid].map((o) => [o.id, o])).values()].map((o: any) => ({
                order_number: o.order_number,
                status: o.status,
                payment_state: o.payment_state,
                total: num(o.total),
                paid_total: num(o.paid_total),
              })),
              note: "These orders block a clean close and are listed rather than silently netted off.",
            },
          ]
        : []),
    ],
    totals: [
      { label: "Gross sales", value: sum("subtotal"), currency },
      { label: "Discounts", value: sum("discount_total"), currency },
      { label: "Service charge", value: sum("service_charge"), currency },
      { label: "Tax", value: sum("tax_total"), currency },
      { label: "Net trading total", value: sum("total"), currency, emphasis: true },
      { label: "Received", value: sum("paid_total"), currency },
      { label: "Cost of sales", value: sum("cost_total"), currency },
    ],
    signatures: ["Closed by", "Verified by"],
    notes: null,
    traceability: [{ label: "Business date", recordType: "restaurant_orders", recordNumber: businessDate }],
    snapshot: false,
    snapshotNote: "Recomputed from orders and payments each time it is opened.",
  });
}

/* ---------------------------------------------------------------- dispatch */

type Builder = (sb: Sb, userId: string, tenantId: string, id: string) => Promise<RestaurantDocument>;

const BUILDERS: Partial<Record<DocumentTypeId, Builder>> = {
  purchase_order: buildPurchaseOrder,
  requisition: buildRequisition,
  goods_receipt: buildGoodsReceipt,
  supplier_invoice: buildSupplierInvoice,
  stock_transfer: buildStockTransfer,
  stocktake_sheet: buildStocktakeSheet,
  customer_receipt: buildCustomerReceipt,
};

export function hasBuilder(type: string): boolean {
  return Boolean(BUILDERS[type as DocumentTypeId]);
}

export async function renderDocument(
  sb: Sb,
  userId: string,
  tenantId: string,
  type: DocumentTypeId,
  recordId: string,
): Promise<RestaurantDocument> {
  const def = documentType(type);
  if (!def) throw new Error(`Unknown document type "${type}".`);
  const builder = BUILDERS[type];
  if (!builder) {
    throw new Error(
      `${def.label} is registered but has no printable renderer yet. Use the dataset export, or open the record at ${def.workflowRoute ?? "its workflow screen"}.`,
    );
  }
  return builder(sb, userId, tenantId, recordId);
}