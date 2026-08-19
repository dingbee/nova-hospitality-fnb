import { describe, expect, it } from "vitest";
import { buildSplit } from "./bill.server";
import { deriveLifecycle } from "./ui/lifecycle";

const line = (id: string, seat: number | null, total: number) => ({
  id,
  seat_number: seat,
  line_total: total,
  status: "served",
});

describe("bill splitting", () => {
  it("groups by seat and reconciles to the bill total", () => {
    const lines = [line("a", 1, 12_000), line("b", 2, 8_500), line("c", null, 4_500)];
    const split = buildSplit(lines, 25_000, 25_000, "seat", 2);
    expect(split.shares.map((s) => s.label)).toEqual(["Seat 1", "Seat 2", "Shared items"]);
    expect(split.shares.reduce((s, x) => s + x.amount, 0)).toBe(25_000);
    expect(split.reconciles).toBe(true);
  });

  it("puts the rounding remainder on the first share when splitting evenly", () => {
    const split = buildSplit([], 100, 100, "even", 3);
    expect(split.shares).toHaveLength(3);
    expect(split.shares.reduce((s, x) => s + x.amount, 0)).toBe(100);
    expect(split.reconciles).toBe(true);
  });

  it("offers the outstanding balance when splitting by amount", () => {
    const split = buildSplit([], 100, 40, "amount", 2);
    expect(split.shares[0]?.amount).toBe(40);
  });
});

describe("settlement lifecycle", () => {
  const served = [{ id: "l1", status: "served" }];

  it("asks for the bill only once everything is served", () => {
    const life = deriveLifecycle({ order: { status: "served", total: 100 }, items: served });
    expect(life.nextAction).toBe("request-bill");
  });

  it("moves to presenting once the guest has asked", () => {
    const life = deriveLifecycle({
      order: { status: "served", total: 100, bill_requested_at: "2026-01-01T10:00:00Z" },
      items: served,
    });
    expect(life.stage).toBe("bill_requested");
    expect(life.nextAction).toBe("present-bill");
  });

  it("keeps a part-paid bill open on the balance", () => {
    const life = deriveLifecycle({
      order: { status: "served", total: 100, paid_total: 40, payment_state: "partially_paid" },
      items: served,
    });
    expect(life.stage).toBe("payment");
    expect(life.balance).toBe(60);
    expect(life.nextAction).toBe("settle-balance");
  });

  it("asks for receipt delivery, then table release, after closing", () => {
    const closed = { status: "closed", total: 100, paid_total: 100, payment_state: "paid", table_id: "t1" };
    expect(deriveLifecycle({ order: closed, items: served }).nextAction).toBe("deliver-receipt");
    const delivered = deriveLifecycle({
      order: closed,
      items: served,
      receipt: { delivered_at: "2026-01-01T11:00:00Z" },
    });
    expect(delivered.stage).toBe("delivered");
    expect(delivered.nextAction).toBe("release-table");
  });
});