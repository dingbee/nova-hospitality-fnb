/**
 * Self-order recovery — lets a guest who reloaded or left /order/$tableId
 * get back to the order they just placed, instead of losing it the moment
 * order.$tableId.tsx's React state resets.
 *
 * The security model in one sentence: localStorage only ever tells this
 * module which orderId to *ask about*. It is never trusted for what that
 * order's status, table, or ownership actually is — every recovery attempt
 * is re-validated server-side through guestOrderStatusFn, the exact same
 * table-scoped guest-authorization path (resolveGuestTableContext +
 * loadGuestOrder) every other guest action in this module already goes
 * through. A tampered, stale, or cross-table id fails that lookup exactly
 * the way a wrong-table request already does today — nothing new was added
 * to the authorization boundary, this only decides what to *ask* it.
 */

/** The minimal storage interface this module needs — satisfied by window.localStorage, or a fake in tests. Kept generic (not "Storage") so a test's in-memory fake doesn't need to implement the full DOM Storage interface. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = "nova.selforder.activeOrder.";
const SESSION_STORAGE_PREFIX = "nova.selforder.session.";
const WELCOME_STORAGE_PREFIX = "nova.selforder.welcomeSeen.";

/** Table-scoped by construction — a key for table A can never collide with, or be read as, table B's. */
function storageKey(tableId: string): string {
  return `${STORAGE_PREFIX}${tableId}`;
}

/** Table-scoped by construction, same as storageKey — a session token stored for table A is never read as table B's. */
function sessionStorageKey(tableId: string): string {
  return `${SESSION_STORAGE_PREFIX}${tableId}`;
}

/** Table-scoped by construction, same as storageKey — welcomeSeen for table A never affects table B. */
function welcomeStorageKey(tableId: string): string {
  return `${WELCOME_STORAGE_PREFIX}${tableId}`;
}

function safeStorage(): KeyValueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private browsing / storage disabled — recovery is a convenience,
    // never a requirement, so this degrades to "nothing stored" silently.
    return null;
  }
}

/** Reads the orderId this table's guest last placed, if any. This is a hint only — never treat its presence as proof of anything. */
export function readStoredOrderId(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): string | null {
  try {
    return storage?.getItem(storageKey(tableId)) ?? null;
  } catch {
    return null;
  }
}

/** Called once an order is successfully placed, so a later visit to this exact table can offer to recover it. */
export function writeStoredOrderId(
  tableId: string,
  orderId: string,
  storage: KeyValueStorage | null = safeStorage(),
): void {
  try {
    storage?.setItem(storageKey(tableId), orderId);
  } catch {
    // See safeStorage — a write failure is never surfaced to the guest.
  }
}

/** Drops the recovery hint for this table — the guest explicitly moved past that order, or the server said it isn't recoverable. */
export function clearStoredOrderId(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): void {
  try {
    storage?.removeItem(storageKey(tableId));
  } catch {
    // See safeStorage.
  }
}

/**
 * The guest's current dining-session token for this table, if any — a hint
 * only, exactly like readStoredOrderId. The server (resolveOrStartGuestSession
 * in selforder.server.ts) is the sole authority on whether it's still
 * active, unexpired, and bound to this table; a stale, wrong-table, or
 * tampered value is simply treated as "no token presented" and never
 * trusted client-side for anything.
 */
export function readStoredSessionToken(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): string | null {
  try {
    return storage?.getItem(sessionStorageKey(tableId)) ?? null;
  } catch {
    return null;
  }
}

/** Called after every successful order submission — the server may have reused the presented token or issued a new one; either way this is what the next submission at this table should present. */
export function writeStoredSessionToken(
  tableId: string,
  sessionToken: string,
  storage: KeyValueStorage | null = safeStorage(),
): void {
  try {
    storage?.setItem(sessionStorageKey(tableId), sessionToken);
  } catch {
    // See safeStorage — a write failure is never surfaced to the guest.
  }
}

/** Drops the session hint for this table — used once the guest's visit is clearly over, so a later, unrelated visit never presents a stale token. */
export function clearStoredSessionToken(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): void {
  try {
    storage?.removeItem(sessionStorageKey(tableId));
  } catch {
    // See safeStorage.
  }
}

/**
 * Whether this browser has already shown the branded welcome screen for
 * this table. A convenience flag only, entirely separate from the O12
 * dining-session token: it decides a UI moment (skip straight to the menu
 * on a reload), never guest authorization — resolveGuestTableContext is
 * re-derived from the URL's tableId on every load regardless of this value.
 */
export function readWelcomeSeen(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): boolean {
  try {
    return storage?.getItem(welcomeStorageKey(tableId)) === "1";
  } catch {
    return false;
  }
}

/** Called once the guest taps past the welcome screen for this table. */
export function writeWelcomeSeen(
  tableId: string,
  storage: KeyValueStorage | null = safeStorage(),
): void {
  try {
    storage?.setItem(welcomeStorageKey(tableId), "1");
  } catch {
    // See safeStorage — a write failure is never surfaced to the guest.
  }
}

/**
 * What a recovered order should look like to the guest, decided purely
 * from server-authoritative fields already returned by guestOrderStatus —
 * nothing here is client-asserted.
 *
 * - "none": nothing to recover — the lookup failed (wrong table, id
 *   doesn't exist, tenant mismatch — guestOrderStatusFn throws in all of
 *   these, identically to any other cross-table guest request), or the
 *   order was cancelled/voided, or it's unpaid and no longer in an active
 *   stage (e.g. closed without payment). There is nothing useful left to
 *   show or continue.
 * - "paid": the order is settled (paymentState "paid", or nothing left
 *   owing) regardless of its status — closing a bill doesn't happen the
 *   moment a guest pays (recordGuestPayment never touches order status),
 *   so a fully paid order can still read as "open"/"sent"/"served".
 *   Skips the choice prompt entirely and goes straight to the existing
 *   paid confirmation view — the guest is never offered to pay again.
 * - "offer": the order is still live (open/sent/served) and not yet
 *   fully paid. The guest is offered an explicit choice — continue it, or
 *   start fresh — rather than being silently dropped back into it.
 */
export type RecoveryOutcome = "none" | "paid" | "offer";

/** The exact set of order statuses insertLines/initiateGuestPayment already treat as "still payable" — reused here as the same authoritative boundary for what "still active" means, not reinvented. Duplicated (not imported) from selfpay.server.ts's PAYABLE_ORDER_STATUSES because that file is server-only and this module is loaded client-side too; this constant makes no authorization decision itself — initiateGuestPayment/confirmGuestPayment independently re-check payability server-side regardless of what this decides to display. */
const ACTIVE_ORDER_STATUSES = new Set(["open", "sent", "served"]);

export function classifyRecoveredOrder(
  order: { status: string; paymentState: string; amountDue: number } | null,
): RecoveryOutcome {
  if (!order) return "none";
  const paid = order.paymentState === "paid" || order.amountDue <= 0;
  if (paid) return "paid";
  return ACTIVE_ORDER_STATUSES.has(order.status) ? "offer" : "none";
}
