import type { PosModifierInput } from "../pos.contracts";

/** A line staged at the till, not yet sent to the server. */
export type CartLine = {
  key: string;
  menuItemId?: string;
  variantId?: string;
  stationId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  seatNumber?: number;
  course?: string;
  notes?: string;
  guestNotes?: string;
  modifiers: PosModifierInput[];
};

export const lineTotal = (l: CartLine) =>
  Number(
    (
      (l.unitPrice + l.modifiers.reduce((s, m) => s + m.priceDelta * m.quantity, 0)) *
      l.quantity
    ).toFixed(2),
  );

export const money = (n: number, currency: string) =>
  `${currency} ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;