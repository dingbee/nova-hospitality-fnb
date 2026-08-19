/**
 * Purchase order state machine — pure and browser-safe.
 *
 * One authoritative definition of which purchase-order transitions exist.
 * Fulfilment states (`partially_received`, `received`) are owned by the
 * receiving service and are never reachable through a manual status change:
 * stock evidence, not a dropdown, decides that an order was received.
 */
import type { PurchaseOrderStatus } from "../core/contracts";

export const PO_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "cancelled"],
  approved: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

/** Statuses only the receiving service may set, from posted stock evidence. */
export const PO_SERVICE_OWNED_STATUSES: readonly PurchaseOrderStatus[] = [
  "partially_received",
  "received",
];

/** Statuses a user may request through the governed transition service. */
export const PO_MANUAL_STATUSES: readonly PurchaseOrderStatus[] = ["submitted", "approved", "cancelled"];

export const PO_TERMINAL_STATUSES: readonly PurchaseOrderStatus[] = ["received", "cancelled"];

export function isTerminalPurchaseOrderStatus(status: string): boolean {
  return (PO_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function canTransitionPurchaseOrder(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): boolean {
  return (PO_TRANSITIONS[from] ?? []).includes(to);
}

/** Throws a readable, commercial error when a transition is not permitted. */
export function assertPurchaseOrderTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
  opts: { serviceOwned?: boolean } = {},
): void {
  if (!opts.serviceOwned && (PO_SERVICE_OWNED_STATUSES as readonly string[]).includes(to)) {
    throw new Error(
      `"${to}" is set by goods receiving from posted stock evidence — it cannot be set directly.`,
    );
  }
  if (isTerminalPurchaseOrderStatus(from)) {
    throw new Error(`A ${from} purchase order is final and cannot move to "${to}".`);
  }
  if (!canTransitionPurchaseOrder(from, to)) {
    throw new Error(`Invalid purchase order transition: ${from} → ${to}.`);
  }
}

/**
 * Statuses an order must hold for goods to be received against it. `draft` has
 * not been issued to anyone; `received` and `cancelled` are final. Receiving
 * owns the business fact, this machine owns whether the state may move.
 */
export const PO_RECEIVABLE_STATUSES: readonly PurchaseOrderStatus[] = [
  "submitted",
  "approved",
  "partially_received",
];

export function assertPurchaseOrderReceivable(status: string): void {
  if (isTerminalPurchaseOrderStatus(status)) {
    throw new Error(
      `A ${status} purchase order is final — goods cannot be received against it, and receiving can never return it to an open state.`,
    );
  }
  if (!(PO_RECEIVABLE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Goods cannot be received against a ${status} purchase order.`);
  }
}

/**
 * The single decision point for fulfilment state after a receipt is posted.
 * Returns the status to persist, or `null` when the order is already in that
 * state (a further partial delivery). Never bypasses the transition rules:
 * an order that is terminal — cancelled included — throws instead.
 */
export function resolveFulfilmentTransition(
  from: PurchaseOrderStatus,
  to: Extract<PurchaseOrderStatus, "partially_received" | "received">,
): PurchaseOrderStatus | null {
  assertPurchaseOrderReceivable(from);
  if (from === to) return null;
  assertPurchaseOrderTransition(from, to, { serviceOwned: true });
  return to;
}
