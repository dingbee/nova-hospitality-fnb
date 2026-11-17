/**
 * Presentation vocabulary for the procurement lifecycle. Pure and browser-safe.
 * Status must be understandable at a glance on a tablet in a store room.
 */
export type LifecycleTone = "success" | "warning" | "danger" | "info" | "neutral";

export interface LifecycleBadge {
  label: string;
  tone: LifecycleTone;
}

const BADGES: Record<string, LifecycleBadge> = {
  /* purchase requests */
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  converted_to_po: { label: "Ordered", tone: "info" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  /* purchase orders */
  partially_received: { label: "Partially received", tone: "warning" },
  received: { label: "Received", tone: "success" },
  /* confirmations */
  pending: { label: "Awaiting confirmation", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  partially_confirmed: { label: "Partly confirmed", tone: "warning" },
  declined: { label: "Declined", tone: "danger" },
  /* receipts */
  posted: { label: "Posted to stock", tone: "success" },
  /* invoices */
  recorded: { label: "Invoiced", tone: "info" },
  matched: { label: "Matched", tone: "success" },
  disputed: { label: "Disputed", tone: "danger" },
  unmatched: { label: "Unmatched", tone: "warning" },
  partially_matched: { label: "Partly matched", tone: "warning" },
  /* payment */
  unpaid: { label: "Unpaid", tone: "warning" },
  partially_paid: { label: "Part paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  /* variances */
  open: { label: "Open", tone: "danger" },
  accepted: { label: "Accepted", tone: "info" },
  resolved: { label: "Resolved", tone: "success" },
  escalated: { label: "Escalated", tone: "danger" },
};

export function lifecycleBadge(status?: string | null): LifecycleBadge {
  if (!status) return { label: "—", tone: "neutral" };
  return BADGES[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" };
}

export const VARIANCE_LABELS: Record<string, string> = {
  quantity: "Quantity",
  price: "Price",
  quality: "Quality",
  delivery: "Delivery",
  tax: "Tax",
  invoice: "Invoice",
};

export const PRIORITY_TONE: Record<string, LifecycleTone> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  urgent: "danger",
};

export function formatMoney(value: number | string | null | undefined, currency = "TZS"): string {
  const n = Number(value ?? 0);
  return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatQty(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
