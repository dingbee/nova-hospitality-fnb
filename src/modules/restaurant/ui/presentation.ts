/** Shared, user-facing formatting for Restaurant & Bar OS. */
export function formatQuantity(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 3 }).format(amount);
}

export function formatMoney(
  value: number | string | null | undefined,
  currency = "TZS",
): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return `${currency} —`;
  return `${currency} ${new Intl.NumberFormat("en-TZ", {
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-TZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const MOVEMENT_LABELS: Record<string, string> = {
  consumption: "Sales consumption",
  wastage: "Wastage",
  transfer_in: "Stock received by transfer",
  transfer_out: "Stock sent by transfer",
  adjustment: "Stock adjustment",
  adjustment_in: "Stock increase",
  adjustment_out: "Stock decrease",
  opening_balance: "Opening stock",
  receipt: "Stock received",
  return_to_supplier: "Returned to supplier",
  reversal: "Reversal",
};

export function formatMovementLabel(value: string): string {
  return MOVEMENT_LABELS[value] ??
    value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function movementQuantityLabel(type: string, quantity: number): string {
  if (type === "consumption") return "Quantity used";
  if (type === "wastage") return "Quantity wasted";
  if (type === "transfer_out") return "Quantity transferred out";
  if (type === "transfer_in") return "Quantity transferred in";
  if (type === "return_to_supplier") return "Quantity returned";
  return quantity < 0 ? "Quantity deducted" : "Quantity added";
}
