export type BarTicketItem = {
  orderItemId: string;
  name: string;
  quantity: number;
  status: string;
};

type TicketItemRecord = {
  ticket_id: string;
  id?: string;
  order_item_id: string | null;
  description: string | null;
  quantity: number | string | null;
  status: string | null;
};

type OrderLineRecord = {
  id: string;
  order_id: string;
  station_id: string | null;
  description: string | null;
  quantity: number | string | null;
  status: string | null;
};

type TicketRecord = { id: string; order_id: string; station_id: string | null };

/**
 * Prefer the persisted KOT lines. If row-level policy visibility yields no
 * lines for a visible ticket, reconstruct only from its own order and station.
 */
export function buildBarTicketItems(
  ticket: TicketRecord,
  ticketItemRows: TicketItemRecord[],
  orderLines: OrderLineRecord[],
): BarTicketItem[] {
  const recorded = ticketItemRows.filter((row) => row.ticket_id === ticket.id);
  if (recorded.length > 0) {
    const orderLineById = new Map(orderLines.map((row) => [row.id, row]));
    return recorded.map((row) => {
      const orderLine = row.order_item_id ? orderLineById.get(row.order_item_id) : undefined;
      return {
        orderItemId: String(row.order_item_id ?? row.id ?? ""),
        name: String(row.description ?? orderLine?.description ?? "Order item"),
        quantity: Number(row.quantity ?? orderLine?.quantity ?? 1),
        status: String(row.status ?? "queued"),
      };
    });
  }

  return orderLines
    .filter((row) =>
      row.order_id === ticket.order_id &&
      row.station_id === ticket.station_id &&
      ["fired", "ready", "served"].includes(String(row.status ?? "").toLowerCase()),
    )
    .map((row) => ({
      orderItemId: row.id,
      name: String(row.description ?? "Order item"),
      quantity: Number(row.quantity ?? 1),
      status: String(row.status ?? "queued"),
    }));
}
