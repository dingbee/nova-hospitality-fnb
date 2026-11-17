/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { guestFeedbackStatus, submitGuestFeedback } from "./selffeedback.server";

/**
 * In-memory Supabase stand-in covering the chains selffeedback.server
 * uses: .from().select().eq()...maybeSingle(), .insert()...single().
 * Mirrors selfbill.server.test.ts's fakeDb, kept local to this file per
 * this module's existing convention.
 */
function fakeDb(seed: {
  tables?: any[];
  tenants?: any[];
  orders?: any[];
  currencies?: any[];
  feedback?: any[];
}) {
  const rows: Record<string, any[]> = {
    restaurant_tables: seed.tables ?? [],
    restaurant_tenants: seed.tenants ?? [],
    restaurant_orders: seed.orders ?? [],
    restaurant_currencies: seed.currencies ?? [],
    restaurant_guest_feedback: seed.feedback ?? [],
  };

  // Real Supabase honours .select("a, b") by returning only those columns —
  // this fake must too, or a "no internal field leaks" test would pass
  // regardless of what the source code actually selects.
  const project = (row: Record<string, unknown> | null, cols: string | undefined) => {
    if (!row) return null;
    if (!cols || cols.trim() === "*") return { ...row };
    const names = cols.split(",").map((c) => c.trim());
    const out: Record<string, unknown> = {};
    for (const n of names) out[n] = row[n];
    return out;
  };

  function from(table: string) {
    let filtered = rows[table] ?? [];
    let selected: string | undefined;
    const builder: any = {
      select(cols?: string) {
        selected = cols;
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => ({ data: project(filtered[0] ?? null, selected) }),
      single: async () => ({
        data: project(filtered[0] ?? null, selected),
        error: filtered[0] ? null : { message: "not found" },
      }),
      insert(row: Record<string, unknown>) {
        const inserted = { ...row };
        rows[table]!.push(inserted);
        return {
          select(cols?: string) {
            return { single: async () => ({ data: project(inserted, cols), error: null }) };
          },
        };
      },
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return builder;
  }

  return { from };
}

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const TABLE = "table-1";
const OTHER_TABLE = "table-2";
const ORDER = "order-1";

function seedFor(
  opts: { orderOverrides?: Partial<Record<string, unknown>>; feedback?: any[] } = {},
) {
  return fakeDb({
    tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
      {
        id: OTHER_TABLE,
        code: "T2",
        name: "T2",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
    ],
    tenants: [
      { id: TENANT, name: "Demo", status: "active" },
      { id: OTHER_TENANT, name: "Other tenant", status: "active" },
    ],
    orders: [
      {
        id: ORDER,
        order_number: "ORD-1",
        status: "closed",
        payment_state: "paid",
        total: 11000,
        paid_total: 11000,
        property_id: null,
        location_id: null,
        table_id: TABLE,
        tenant_id: TENANT,
        ...opts.orderOverrides,
      },
    ],
    feedback: (opts.feedback ?? []).map((f) => ({ tenant_id: TENANT, order_id: ORDER, ...f })),
  });
}

describe("submitGuestFeedback", () => {
  it("a valid completed/paid order can submit feedback", async () => {
    const sb = seedFor();
    const result = await submitGuestFeedback(sb, {
      tableId: TABLE,
      orderId: ORDER,
      rating: 5,
      comment: "Great meal!",
    });
    expect(result).toEqual({
      ok: true,
      routing: "advocacy_ready",
      rating: 5,
      comment: "Great meal!",
    });
  });

  it("an unpaid order is rejected", async () => {
    const sb = seedFor({ orderOverrides: { payment_state: "unpaid", paid_total: 0 } });
    const result = await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 5 });
    expect(result).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("a partially-paid order is rejected", async () => {
    const sb = seedFor({ orderOverrides: { payment_state: "partially_paid", paid_total: 4000 } });
    const result = await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 4 });
    expect(result).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("the wrong table cannot submit feedback for this order", async () => {
    const sb = seedFor();
    await expect(
      submitGuestFeedback(sb, { tableId: OTHER_TABLE, orderId: ORDER, rating: 5 }),
    ).rejects.toThrow(/not found/i);
  });

  it("a table belonging to a different tenant cannot submit feedback for this order", async () => {
    const sb = fakeDb({
      tables: [
        {
          id: "table-cross-tenant",
          code: "TX",
          name: "TX",
          tenant_id: OTHER_TENANT,
          property_id: null,
          location_id: null,
          active: true,
        },
      ],
      tenants: [
        { id: TENANT, name: "Demo", status: "active" },
        { id: OTHER_TENANT, name: "Other tenant", status: "active" },
      ],
      orders: [
        {
          id: ORDER,
          order_number: "ORD-1",
          status: "closed",
          payment_state: "paid",
          total: 11000,
          paid_total: 11000,
          table_id: "table-cross-tenant",
          tenant_id: TENANT,
        },
      ],
    });
    await expect(
      submitGuestFeedback(sb, { tableId: "table-cross-tenant", orderId: ORDER, rating: 5 }),
    ).rejects.toThrow(/not found/i);
  });

  it("a nonexistent order is safely rejected, not silently accepted", async () => {
    const sb = seedFor();
    await expect(
      submitGuestFeedback(sb, { tableId: TABLE, orderId: "no-such-order", rating: 5 }),
    ).rejects.toThrow(/not found/i);
  });

  it("a duplicate submission is idempotent — the second call returns the original, not a new one", async () => {
    const sb = seedFor();
    const first = await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 2 });
    const second = await submitGuestFeedback(sb, {
      tableId: TABLE,
      orderId: ORDER,
      rating: 5,
      comment: "trying to overwrite",
    });
    expect(second).toEqual(first);
  });

  it("a guest cannot modify feedback already submitted — a different rating/comment on the retry is silently ignored", async () => {
    const sb = seedFor({ feedback: [{ rating: 1, comment: "terrible" }] });
    const result = await submitGuestFeedback(sb, {
      tableId: TABLE,
      orderId: ORDER,
      rating: 5,
      comment: "actually it was great",
    });
    expect(result).toEqual({
      ok: true,
      routing: "service_recovery",
      rating: 1,
      comment: "terrible",
    });
  });

  it("repeated taps never create more than one feedback row", async () => {
    const sb = seedFor();
    await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 4 });
    await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 4 });
    const { data } = await (sb.from("restaurant_guest_feedback") as any)
      .select()
      .eq("order_id", ORDER);
    expect(data).toHaveLength(1);
  });

  it("a concurrent insert conflict (the database's own uniqueness guard) falls back to the row that won the race", async () => {
    const RACED = { rating: 3, comment: null };
    let selectCalls = 0;
    const sb = {
      from(table: string) {
        if (table === "restaurant_guest_feedback") {
          const builder: any = {
            select() {
              return builder;
            },
            eq() {
              return builder;
            },
            maybeSingle: async () => {
              selectCalls += 1;
              return { data: selectCalls === 1 ? null : RACED };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "23505", message: "conflict" },
                  }),
                }),
              };
            },
          };
          return builder;
        }
        return seedFor().from(table);
      },
    };
    const result = await submitGuestFeedback(sb as any, {
      tableId: TABLE,
      orderId: ORDER,
      rating: 5,
    });
    expect(result).toEqual({ ok: true, routing: "thanks", ...RACED });
  });

  it("no internal data (ids, tenant/table/order internals) is exposed in the result", async () => {
    const sb = seedFor();
    const result = await submitGuestFeedback(sb, { tableId: TABLE, orderId: ORDER, rating: 5 });
    expect(Object.keys(result).sort()).toEqual(["comment", "ok", "rating", "routing"].sort());
  });
});

describe("guestFeedbackStatus", () => {
  it("an unpaid order is not eligible for feedback", async () => {
    const sb = seedFor({ orderOverrides: { payment_state: "unpaid", paid_total: 0 } });
    const status = await guestFeedbackStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({ eligible: false });
  });

  it("a paid order with no feedback yet is eligible but not submitted", async () => {
    const sb = seedFor();
    const status = await guestFeedbackStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({ eligible: true, submitted: false });
  });

  it("a paid order with existing feedback reports it, with no internal fields leaked", async () => {
    const sb = seedFor({ feedback: [{ rating: 4, comment: "nice" }] });
    const status = await guestFeedbackStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({
      eligible: true,
      submitted: true,
      routing: "advocacy_ready",
      rating: 4,
      comment: "nice",
    });
  });

  it("the wrong table cannot read feedback status for this order", async () => {
    const sb = seedFor();
    await expect(guestFeedbackStatus(sb, { tableId: OTHER_TABLE, orderId: ORDER })).rejects.toThrow(
      /not found/i,
    );
  });
});
