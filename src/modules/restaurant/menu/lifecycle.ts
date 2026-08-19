/**
 * Sprint 5.11 — menu item lifecycle. Pure, no I/O.
 *
 * "Exists" and "sellable" are different questions. Lifecycle answers the first;
 * availability (derived from stock, recipe, outlet and price) answers the second.
 */

export const MENU_LIFECYCLE_STATES = [
  "draft",
  "active",
  "paused",
  "discontinued",
  "archived",
] as const;
export type MenuLifecycleState = (typeof MENU_LIFECYCLE_STATES)[number];

export const MENU_LIFECYCLE_LABEL: Record<MenuLifecycleState, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  discontinued: "Discontinued",
  archived: "Archived",
};

export const MENU_LIFECYCLE_MEANING: Record<MenuLifecycleState, string> = {
  draft: "Being prepared. Never offered to guests.",
  active: "Offered for sale when availability allows.",
  paused: "Temporarily off sale. Master data untouched.",
  discontinued: "Permanently off sale. History preserved.",
  archived: "Removed from working views. History preserved.",
};

/** Lifecycle actions a human can take. */
export const MENU_LIFECYCLE_ACTIONS = [
  "activate",
  "pause",
  "resume",
  "discontinue",
  "archive",
  "restore",
] as const;
export type MenuLifecycleAction = (typeof MENU_LIFECYCLE_ACTIONS)[number];

const TRANSITIONS: Record<MenuLifecycleAction, { from: MenuLifecycleState[]; to: MenuLifecycleState }> = {
  activate: { from: ["draft", "paused", "discontinued", "archived"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  discontinue: { from: ["draft", "active", "paused"], to: "discontinued" },
  archive: { from: ["draft", "paused", "discontinued"], to: "archived" },
  restore: { from: ["archived", "discontinued"], to: "paused" },
};

export function nextLifecycleState(
  current: MenuLifecycleState,
  action: MenuLifecycleAction,
): MenuLifecycleState | null {
  const t = TRANSITIONS[action];
  return t.from.includes(current) ? t.to : null;
}

export function allowedLifecycleActions(current: MenuLifecycleState): MenuLifecycleAction[] {
  return MENU_LIFECYCLE_ACTIONS.filter((a) => nextLifecycleState(current, a) != null);
}

/** Canonical event emitted for a lifecycle transition. */
export const LIFECYCLE_EVENT: Record<MenuLifecycleState, string> = {
  draft: "restaurant.menu.item.updated",
  active: "restaurant.menu.item.activated",
  paused: "restaurant.menu.item.paused",
  discontinued: "restaurant.menu.item.discontinued",
  archived: "restaurant.menu.item.archived",
};

/* ------------------------------ deletion ------------------------------ */

export interface MenuItemUsage {
  /** Order lines that ever referenced the item, voided or not. */
  orderLines: number;
  /** Receipts / documents that captured the item in a frozen snapshot. */
  documents: number;
  /** Recipe cost rows, intelligence evidence, etc. */
  derivedRecords: number;
}

export type DeletionVerdict =
  | { deletable: true; reason: string }
  | { deletable: false; reason: string; alternatives: MenuLifecycleAction[] };

/**
 * Physical deletion is only ever allowed for an item that never took part in a
 * transaction. Everything else keeps its history and is discontinued/archived.
 */
export function evaluateDeletion(usage: MenuItemUsage): DeletionVerdict {
  const total = usage.orderLines + usage.documents + usage.derivedRecords;
  if (total === 0) {
    return { deletable: true, reason: "No transactional or derived history references this item." };
  }
  const parts: string[] = [];
  if (usage.orderLines > 0) parts.push(`${usage.orderLines} order line(s)`);
  if (usage.documents > 0) parts.push(`${usage.documents} issued document(s)`);
  if (usage.derivedRecords > 0) parts.push(`${usage.derivedRecords} derived record(s)`);
  return {
    deletable: false,
    reason: `Historical integrity: ${parts.join(", ")} reference this item.`,
    alternatives: ["discontinue", "archive"],
  };
}