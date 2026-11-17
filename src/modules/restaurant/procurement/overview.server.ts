/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Procurement Centre overview: the lifecycle at a glance, with each stage kept
 * distinct rather than collapsed into a single status count.
 */
import type { z } from "zod";
import { assertTenantRead } from "../core/access.server";
import type { listAuditSchema } from "./contracts";

type Sb = any;

export async function procurementOverview(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);

  const [{ data: requests }, { data: orders }, { data: receipts }, { data: invoices }, { data: variances }] =
    await Promise.all([
      sb.from("restaurant_purchase_requests").select("id, status, estimated_total").eq("tenant_id", tenantId),
      sb
        .from("restaurant_purchase_orders")
        .select("id, status, confirmation_status, total, expected_at")
        .eq("tenant_id", tenantId),
      sb.from("restaurant_goods_receipts").select("id, status, accepted_value").eq("tenant_id", tenantId),
      sb
        .from("restaurant_supplier_invoices")
        .select("id, status, payment_status, match_status, total, amount_paid, due_date")
        .eq("tenant_id", tenantId),
      sb.from("restaurant_procurement_variances").select("id, status, severity").eq("tenant_id", tenantId),
    ]);

  const reqRows = (requests ?? []) as any[];
  const orderRows = (orders ?? []) as any[];
  const receiptRows = (receipts ?? []) as any[];
  const invoiceRows = (invoices ?? []) as any[];
  const varRows = (variances ?? []) as any[];
  const today = new Date().toISOString().slice(0, 10);

  const outstanding = invoiceRows
    .filter((i) => i.payment_status !== "paid" && i.status !== "cancelled")
    .reduce((s, i) => s + (Number(i.total ?? 0) - Number(i.amount_paid ?? 0)), 0);

  return {
    needed: {
      draft: reqRows.filter((r) => r.status === "draft").length,
      awaitingApproval: reqRows.filter((r) => r.status === "submitted").length,
      approved: reqRows.filter((r) => r.status === "approved").length,
      approvedValue: reqRows
        .filter((r) => r.status === "approved")
        .reduce((s, r) => s + Number(r.estimated_total ?? 0), 0),
    },
    ordered: {
      open: orderRows.filter((o) => ["submitted", "approved", "partially_received"].includes(o.status)).length,
      awaitingConfirmation: orderRows.filter(
        (o) =>
          ["submitted", "approved"].includes(o.status) &&
          (!o.confirmation_status || o.confirmation_status === "pending"),
      ).length,
      overdue: orderRows.filter(
        (o) => o.expected_at && o.expected_at < today && o.status !== "received" && o.status !== "cancelled",
      ).length,
      openValue: orderRows
        .filter((o) => ["submitted", "approved", "partially_received"].includes(o.status))
        .reduce((s, o) => s + Number(o.total ?? 0), 0),
    },
    received: {
      draft: receiptRows.filter((r) => r.status === "draft").length,
      posted: receiptRows.filter((r) => r.status === "posted").length,
      acceptedValue: receiptRows
        .filter((r) => r.status === "posted")
        .reduce((s, r) => s + Number(r.accepted_value ?? 0), 0),
    },
    invoiced: {
      recorded: invoiceRows.filter((i) => i.status === "recorded").length,
      matched: invoiceRows.filter((i) => i.match_status === "matched").length,
      mismatched: invoiceRows.filter((i) => i.match_status === "mismatched").length,
      unpaid: invoiceRows.filter((i) => i.payment_status === "unpaid").length,
      overdue: invoiceRows.filter(
        (i) => i.due_date && i.due_date < today && i.payment_status !== "paid",
      ).length,
      outstandingValue: Number(outstanding.toFixed(2)),
    },
    variances: {
      open: varRows.filter((v) => v.status === "open").length,
      high: varRows.filter((v) => v.status === "open" && v.severity === "high").length,
      escalated: varRows.filter((v) => v.status === "escalated").length,
    },
  };
}

export async function listProcurementAudit(sb: Sb, userId: string, input: z.infer<typeof listAuditSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_procurement_audit")
    .select(
      "id, document_type, document_id, document_number, action, previous_state, new_state, reason, actor_id, metadata, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.documentType) q = q.eq("document_type", input.documentType);
  if (input.documentId) q = q.eq("document_id", input.documentId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}
