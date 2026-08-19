/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * UAT-1 integrity tests.
 *
 * These assert the properties that must hold no matter which screen the user
 * came from: a void unwinds stock exactly once, cancellation is governed by
 * state rather than by intent, and no outbound movement may silently drive a
 * balance negative.
 *
 * The fake below is a miniature ledger, not a mock of call order: it applies
 * movements to balances and enforces the dedupe uniqueness the database
 * enforces, so the tests fail if the real invariant breaks rather than if an
 * implementation detail changes.
 */
import { describe, expect, it } from "vitest";
import { evaluateNegativeStock } from "./policy";
import { evaluateCancellation } from "../sales/cancellation";
import { reverseMovementsForOrderItem } from "./reversal.server";

interface FakeItem {
  id: string;
  name: string;
  current_quantity: number;
  allow_negative: boolean;
}

function makeLedger(items: FakeItem[]) {
  const movements: any[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  let seq = 0;

  const table = (name: string) => {
    if (name === "restaurant_inventory_items") {
      const filters: Record<string, string> = {};
      const api: any = {
        select: () => api,
        eq: (col: string, val: string) => {
          filters[col] = val;
          return api;
        },
        maybeSingle: async () => ({ data: byId.get(filters['id'] ?? "") ?? null }),
        single: async () => ({ data: byId.get(filters['id'] ?? "") ?? null }),
      };
      return api;
    }

    const conds: Array<(r: any) => boolean> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        conds.push((r) => r[col] === val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        conds.push((r) => vals.includes(r[col]));
        return api;
      },
      then: (resolve: (v: any) => void) => resolve({ data: movements.filter((r) => conds.every((c) => c(r))) }),
      insert: (row: any) => ({
        select: () => ({
          single: async () => {
            if (row.dedupe_key && movements.some((m) => m.dedupe_key === row.dedupe_key)) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const item = byId.get(row.inventory_item_id);
            if (item) item.current_quantity = Number((item.current_quantity + Number(row.quantity)).toFixed(6));
            const stored = { ...row, id: `mv-${++seq}`, balance_after: item?.current_quantity ?? null };
            movements.push(stored);
            return { data: stored, error: null };
          },
        }),
      }),
    };
    return api;
  };

  return { sb: { from: table } as any, movements, item: (id: string) => byId.get(id)! };
}

/** One consumption movement as the sales path writes it. */
function consumption(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "mv-original",
    tenant_id: "t1",
    property_id: null,
    location_id: "loc1",
    destination_location_id: null,
    inventory_item_id: "item1",
    unit_id: "u1",
    movement_type: "consumption",
    quantity: -2,
    unit_cost: 500,
    currency: "TZS",
    batch_id: null,
    correlation_id: null,
    reference_type: "restaurant_order",
    reference_id: "order1",
    order_item_id: "line1",
    dedupe_key: "consume:line1:r1",
    ...over,
  };
}

describe("negative stock policy", () => {
  it("refuses an outbound movement that would break the balance", () => {
    const d = evaluateNegativeStock({
      movementType: "consumption",
      quantity: -5,
      currentQuantity: 3,
      allowNegative: false,
      itemName: "Gin",
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.code).toBe("negative_stock");
      expect(d.shortfall).toBe(2);
      expect(d.message).toContain("Gin");
    }
  });

  it("permits it when the item allows negative stock or a supervisor approved it", () => {
    expect(
      evaluateNegativeStock({ movementType: "wastage", quantity: -5, currentQuantity: 0, allowNegative: true }).allowed,
    ).toBe(true);
    expect(
      evaluateNegativeStock({
        movementType: "transfer_out",
        quantity: -5,
        currentQuantity: 0,
        allowNegative: false,
        approvedBy: "user-1",
      }).allowed,
    ).toBe(true);
  });

  it("never blocks a correction, because corrections exist to repair a wrong balance", () => {
    for (const movementType of ["reversal", "adjustment"] as const) {
      expect(evaluateNegativeStock({ movementType, quantity: -50, currentQuantity: 0, allowNegative: false }).allowed).toBe(
        true,
      );
    }
  });

  it("applies to every outbound path, not just manual wastage", () => {
    for (const movementType of ["consumption", "wastage", "transfer_out", "adjustment_out", "return_to_supplier"] as const) {
      expect(
        evaluateNegativeStock({ movementType, quantity: -1, currentQuantity: 0, allowNegative: false }).allowed,
      ).toBe(false);
    }
  });
});

describe("ledger reversal", () => {
  it("restores stock and value at the cost the sale booked", async () => {
    const led = makeLedger([{ id: "item1", name: "Gin", current_quantity: 8, allow_negative: false }]);
    led.movements.push(consumption());

    const result = await reverseMovementsForOrderItem(led.sb, "user-1", {
      tenantId: "t1",
      orderItemId: "line1",
      reason: "Line void: wrong table",
    });

    expect(result.reversed).toBe(1);
    expect(result.costRestored).toBe(1000);
    expect(led.item("item1").current_quantity).toBe(10);

    const written = led.movements.at(-1);
    expect(written.movement_type).toBe("reversal");
    expect(written.quantity).toBe(2);
    expect(written.unit_cost).toBe(500);
    expect(written.reversal_of_id).toBe("mv-original");
    expect(written.batch_id).toBeNull();
  });

  it("is idempotent: reversing twice corrects stock once", async () => {
    const led = makeLedger([{ id: "item1", name: "Gin", current_quantity: 8, allow_negative: false }]);
    led.movements.push(consumption());
    const args = { tenantId: "t1", orderItemId: "line1", reason: "double tap" };

    const first = await reverseMovementsForOrderItem(led.sb, "user-1", args);
    const second = await reverseMovementsForOrderItem(led.sb, "user-1", args);

    expect(first.reversed).toBe(1);
    expect(second.reversed).toBe(0);
    expect(second.alreadyReversed).toBe(1);
    expect(led.item("item1").current_quantity).toBe(10);
  });

  it("reverses every ingredient a composed sale consumed", async () => {
    const led = makeLedger([
      { id: "item1", name: "Gin", current_quantity: 8, allow_negative: false },
      { id: "item2", name: "Tonic", current_quantity: 20, allow_negative: false },
    ]);
    led.movements.push(consumption());
    led.movements.push(
      consumption({ id: "mv-original-2", inventory_item_id: "item2", quantity: -4, unit_cost: 100, dedupe_key: "consume:line1:r2" }),
    );

    const result = await reverseMovementsForOrderItem(led.sb, "user-1", { tenantId: "t1", orderItemId: "line1", reason: "void" });

    expect(result.reversed).toBe(2);
    expect(result.costRestored).toBe(1400);
    expect(led.item("item1").current_quantity).toBe(10);
    expect(led.item("item2").current_quantity).toBe(24);
  });

  it("does nothing when the sale never consumed stock", async () => {
    const led = makeLedger([{ id: "item1", name: "Gin", current_quantity: 8, allow_negative: false }]);
    const result = await reverseMovementsForOrderItem(led.sb, "user-1", { tenantId: "t1", orderItemId: "line1", reason: "void" });
    expect(result).toMatchObject({ reversed: 0, alreadyReversed: 0, costRestored: 0 });
    expect(led.movements).toHaveLength(0);
  });
});

describe("order cancellation state machine", () => {
  const base = { status: "open", paymentState: "unpaid", outstandingPaid: 0, preparedLines: 0, consumedMovements: 0 };

  it("cancels an unpaid bill and reverses stock only when stock moved", () => {
    expect(evaluateCancellation(base)).toMatchObject({ outcome: "cancel", reverseStock: false });
    expect(evaluateCancellation({ ...base, status: "closed", consumedMovements: 3 })).toMatchObject({
      outcome: "cancel",
      reverseStock: true,
    });
  });

  it("refuses to cancel while money is still held on the bill", () => {
    const d = evaluateCancellation({ ...base, status: "closed", paymentState: "paid", outstandingPaid: 42000 });
    expect(d).toMatchObject({ outcome: "refuse", code: "refund_required" });
  });

  it("refuses a room-charged or comped bill until the settlement is reversed", () => {
    expect(evaluateCancellation({ ...base, paymentState: "room_charged" })).toMatchObject({
      outcome: "refuse",
      code: "settlement_required",
    });
  });

  it("treats a second cancellation as a no-op rather than an error", () => {
    expect(evaluateCancellation({ ...base, status: "cancelled" })).toMatchObject({ outcome: "noop" });
  });

  it("flags prepared lines so the kitchen loss is recorded, not hidden", () => {
    expect(evaluateCancellation({ ...base, status: "served", preparedLines: 2 })).toMatchObject({
      outcome: "cancel",
      wastageLikely: true,
    });
  });
});
