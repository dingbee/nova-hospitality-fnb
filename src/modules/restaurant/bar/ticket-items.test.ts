import { describe, expect, it } from "vitest";
import { buildBarTicketItems } from "./ticket-items";

const ticket = { id: "ticket-1", order_id: "order-1", station_id: "bar-1" };

describe("buildBarTicketItems", () => {
  it("renders persisted ticket lines with their item names and quantities", () => {
    expect(buildBarTicketItems(ticket, [{
      id: "ticket-item-1",
      ticket_id: "ticket-1",
      order_item_id: "order-item-1",
      description: "Safari Lager",
      quantity: "6.000",
      status: "preparing",
    }], [])).toEqual([{
      orderItemId: "order-item-1",
      name: "Safari Lager",
      quantity: 6,
      status: "preparing",
    }]);
  });

  it("falls back to order lines only for the same order and station", () => {
    const lines = [
      { id: "line-1", order_id: "order-1", station_id: "bar-1", description: "Safari Lager", quantity: "6", status: "fired" },
      { id: "line-2", order_id: "order-1", station_id: "kitchen-1", description: "Pilau", quantity: "1", status: "fired" },
      { id: "line-3", order_id: "other-order", station_id: "bar-1", description: "Wine", quantity: "2", status: "fired" },
      { id: "line-4", order_id: "order-1", station_id: "bar-1", description: "Voided drink", quantity: "1", status: "voided" },
    ];
    expect(buildBarTicketItems(ticket, [], lines)).toEqual([{
      orderItemId: "line-1",
      name: "Safari Lager",
      quantity: 6,
      status: "fired",
    }]);
  });

  it("does not invent ticket lines when neither source contains matching rows", () => {
    expect(buildBarTicketItems(ticket, [], [])).toEqual([]);
  });
});
