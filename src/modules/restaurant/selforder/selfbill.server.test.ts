/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { requestGuestBill } from "./selfbill.server";

/**
 * An in-memory Supabase stand-in covering exactly the chains
 * selfbill.server uses: .from().select().eq()...maybeSingle(), .update().
 * Mirrors selfpay.server.test.ts's fakeDb — same shape, kept local to this
 * file rather than shared, matching how every other .server.test.ts in
 * this module already does it.
 */
function fakeDb(seed: { tables?: any[]; tenants?: any[]; orders?: any[]; currencies?: any[] }) {
  const rows: Record<string, any[]> = {
    restaurant_tables: seed.tables ?? [],
    restaurant_tenants: seed.tenants ?? [],
    restaurant_orders: seed.orders ?? [],
    restaurant_currencies: seed.currencies ?? [],
  };

  function from(table: string) {
    let filtered = rows[table] ?? [];
    let pendingPatch: Record<string, unknown> | null = null;
    const applyPatch = () => {
      if (!pendingPatch) return;
      for (const r of filtered) Object.assign(r, pendingPatch);
    };
    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => {
        applyPatch();
        return { data: filtered[0] ?? null };
      },
      single: async () => {
        applyPatch();
        return { data: filtered[0] ?? null, error: filtered[0] ? null : { message: "not found" } };
      },
      update(patch: Record<string, unknown>) {
        pendingPatch = patch;
        return builder;
      },
      // resolves the bare query too (resolveGuestTableContext's currency lookup awaits the chain directly)
      then: (resolve: (v: { data: any[] }) => unknown) => {
        applyPatch();
        return resolve({ data: filtered });
      },
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

function seedFor(orderOverrides: Partial<Record<string, unknown>> = {}) {
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
        status: "open",
        bill_requested_at: null,
        bill_requested_by: null,
        bill_presented_at: null,
        total: 11000,
        currency: "TZS",
        table_id: TABLE,
        tenant_id: TENANT,
        ...orderOverrides,
      },
    ],
  });
}

describe("requestGuestBill", () => {
  it("a valid guest/table/order can request a bill", async () => {
    const sb = seedFor();
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toMatchObject({ ok: true, billPresentedAt: null });
    expect((result as any).billRequestedAt).toBeTruthy();
  });

  it("the order's bill_requested_at is actually set, and bill_requested_by stays null — no staff pseudo-identity invented", async () => {
    const sb = seedFor();
    await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    const row = (sb.from("restaurant_orders") as any).select().eq("id", ORDER);
    const { data } = await row.maybeSingle();
    expect(data.bill_requested_at).toBeTruthy();
    expect(data.bill_requested_by).toBeNull();
  });

  it("the wrong table cannot request a bill for this order", async () => {
    const sb = seedFor();
    await expect(requestGuestBill(sb, { tableId: OTHER_TABLE, orderId: ORDER })).rejects.toThrow(
      /not found/i,
    );
  });

  it("a table belonging to a different tenant cannot request a bill for this order", async () => {
    // A table row that exists, resolves to a real active tenant, but is not
    // the tenant that owns ORDER — loadGuestOrderForBill's tenant_id scope
    // must reject this exactly like a wrong-table request, not merely a
    // wrong-table-id one.
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
          status: "open",
          bill_requested_at: null,
          bill_presented_at: null,
          total: 11000,
          currency: "TZS",
          table_id: "table-cross-tenant",
          tenant_id: TENANT,
        },
      ],
    });
    await expect(
      requestGuestBill(sb, { tableId: "table-cross-tenant", orderId: ORDER }),
    ).rejects.toThrow(/not found/i);
  });

  it("a nonexistent order is safely rejected, not silently accepted", async () => {
    const sb = seedFor();
    await expect(
      requestGuestBill(sb, { tableId: TABLE, orderId: "no-such-order" }),
    ).rejects.toThrow(/not found/i);
  });

  it("a cancelled order cannot request a bill", async () => {
    const sb = seedFor({ status: "cancelled" });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: false, reason: "not_requestable", orderStatus: "cancelled" });
  });

  it("a voided order cannot request a bill", async () => {
    const sb = seedFor({ status: "voided" });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: false, reason: "not_requestable", orderStatus: "voided" });
  });

  it("a closed order (with no bill ever requested) cannot request a bill", async () => {
    const sb = seedFor({ status: "closed" });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: false, reason: "not_requestable", orderStatus: "closed" });
  });

  it("a duplicate request is idempotent — the second call returns the same timestamp, not a new one", async () => {
    const sb = seedFor();
    const first = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    const second = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(first).toEqual(second);
  });

  it("an already-requested order preserves its original bill_requested_at rather than being overwritten", async () => {
    const ALREADY = "2026-01-01T10:00:00.000Z";
    const sb = seedFor({ bill_requested_at: ALREADY });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: true, billRequestedAt: ALREADY, billPresentedAt: null });
  });

  it("an already-presented bill's state is preserved — this function never writes bill_presented_at", async () => {
    const REQUESTED = "2026-01-01T10:00:00.000Z";
    const PRESENTED = "2026-01-01T10:05:00.000Z";
    const sb = seedFor({ bill_requested_at: REQUESTED, bill_presented_at: PRESENTED });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: true, billRequestedAt: REQUESTED, billPresentedAt: PRESENTED });
  });

  it("an already-requested order for a closed status still returns the preserved state, not not_requestable — the idempotency check runs before the status gate", async () => {
    const ALREADY = "2026-01-01T10:00:00.000Z";
    const sb = seedFor({ status: "closed", bill_requested_at: ALREADY });
    const result = await requestGuestBill(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: true, billRequestedAt: ALREADY, billPresentedAt: null });
  });
});
