/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-14 — notification failure isolation (ME14-04).
 *
 * requestDelivery() runs strictly after the receipt (and the order/payment
 * it was issued from) is already committed — delivery is an append-only
 * attempt record, never a rewrite of the financial document. These tests
 * prove that end to end against a real requestDelivery() call, not just by
 * reading the code: a failing/hanging notification provider must never
 * throw out of requestDelivery, must never touch the receipt's money
 * fields, must record the failure observably, and a retry with the same
 * idempotencyKey must never re-invoke the provider or create a second
 * delivery row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestDelivery } from "./delivery.server";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  assertTenantRead: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));
vi.mock("@/lib/notifications/adapters.server", () => ({
  emailConfigured: vi.fn(() => true),
  whatsappConfigured: vi.fn(() => true),
  renderReceiptEmail: vi.fn(() => ({ subject: "s", html: "<p/>", text: "t" })),
  sendEmail: vi.fn(),
  sendWhatsApp: vi.fn(),
}));

const { sendEmail } = await import("@/lib/notifications/adapters.server");

const TENANT = "tenant-1";
const USER = "user-1";
const RECEIPT = "receipt-1";
const ORDER = "order-1";

function fakeSupabase(seed: { receipts: any[]; deliveries: any[] }) {
  const tables: Record<string, any[]> = {
    restaurant_receipts: seed.receipts,
    restaurant_receipt_deliveries: seed.deliveries,
    restaurant_document_events: [],
  };
  let seq = 0;

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    let countMode = false;
    const api: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) countMode = true;
        return api;
      },
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      order: () => api,
      limit: () => api,
      then: (resolve: (v: any) => unknown) =>
        resolve(
          countMode ? { count: filtered.length, error: null } : { data: filtered, error: null },
        ),
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single: async () =>
        filtered.length
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: `${table}: not found` } },
      insert: (row: any) => {
        if (
          table === "restaurant_receipt_deliveries" &&
          rows.some(
            (r) => r.tenant_id === row.tenant_id && r.idempotency_key === row.idempotency_key,
          )
        ) {
          const conflict = {
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          };
          return { select: () => ({ single: async () => conflict }) };
        }
        const stored = { id: `delivery-${++seq}`, ...row };
        rows.push(stored);
        filtered = [stored];
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
      update: (patch: any) => {
        let lastMatched: any[] = rows;
        const target: any = {
          eq: (col: string, val: unknown) => {
            lastMatched = lastMatched.filter((r) => r[col] === val);
            for (const r of lastMatched) Object.assign(r, patch);
            return target;
          },
          select: () => ({
            single: async () =>
              lastMatched.length
                ? { data: lastMatched[0], error: null }
                : { data: null, error: { message: "not found" } },
          }),
        };
        return target;
      },
    };
    return api;
  }

  return { from, tables } as any;
}

function baseReceipt() {
  return {
    id: RECEIPT,
    tenant_id: TENANT,
    property_id: "prop-1",
    location_id: "loc-1",
    order_id: ORDER,
    receipt_number: "R-0001",
    currency: "TZS",
    total: 5000,
    paid_total: 5000,
    snapshot: { lines: [], payments: [] },
  };
}

describe("requestDelivery — notification failure isolation (ME-14 ME14-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a provider network failure is recorded as a failed delivery attempt, never thrown, and never mutates the receipt's money fields", async () => {
    (sendEmail as any).mockResolvedValueOnce({
      ok: false,
      provider: "email",
      reason: "network",
      error: "network timeout",
    });
    const sb = fakeSupabase({ receipts: [baseReceipt()], deliveries: [] });

    const result = await requestDelivery(sb, USER, {
      tenantId: TENANT,
      receiptId: RECEIPT,
      method: "email",
      recipient: "guest@example.com",
      idempotencyKey: "deliver-attempt-1",
    } as any);

    // Failure is observable, not swallowed and not thrown.
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("network_timeout");

    // The receipt itself — the actual financial document — was never
    // touched by the failed delivery attempt.
    const receipt = sb.tables.restaurant_receipts[0];
    expect(receipt.total).toBe(5000);
    expect(receipt.paid_total).toBe(5000);
    expect(receipt.delivered_at).toBeUndefined();

    expect(sb.tables.restaurant_receipt_deliveries).toHaveLength(1);
  });

  it("retrying the same idempotencyKey after a failure does not call the provider again and does not create a second delivery row", async () => {
    (sendEmail as any).mockResolvedValueOnce({
      ok: false,
      provider: "email",
      reason: "network",
      error: "network timeout",
    });
    const sb = fakeSupabase({ receipts: [baseReceipt()], deliveries: [] });

    const first = await requestDelivery(sb, USER, {
      tenantId: TENANT,
      receiptId: RECEIPT,
      method: "email",
      recipient: "guest@example.com",
      idempotencyKey: "deliver-retry-1",
    } as any);
    expect(first.status).toBe("failed");

    const second = await requestDelivery(sb, USER, {
      tenantId: TENANT,
      receiptId: RECEIPT,
      method: "email",
      recipient: "guest@example.com",
      idempotencyKey: "deliver-retry-1",
    } as any);

    expect((second as any).duplicate).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sb.tables.restaurant_receipt_deliveries).toHaveLength(1);
  });

  it("a successful delivery after a prior failed attempt (deliberate staff retry, new key) records a second, distinct attempt row", async () => {
    (sendEmail as any)
      .mockResolvedValueOnce({ ok: false, provider: "email", reason: "network", error: "timeout" })
      .mockResolvedValueOnce({ ok: true, provider: "email", reference: "msg-1" });
    const sb = fakeSupabase({ receipts: [baseReceipt()], deliveries: [] });

    const first = await requestDelivery(sb, USER, {
      tenantId: TENANT,
      receiptId: RECEIPT,
      method: "email",
      recipient: "guest@example.com",
      idempotencyKey: "deliver-key-a",
    } as any);
    expect(first.status).toBe("failed");

    const second = await requestDelivery(sb, USER, {
      tenantId: TENANT,
      receiptId: RECEIPT,
      method: "email",
      recipient: "guest@example.com",
      idempotencyKey: "deliver-key-b",
    } as any);
    expect(second.status).toBe("sent");
    expect(sb.tables.restaurant_receipt_deliveries).toHaveLength(2);

    const receipt = sb.tables.restaurant_receipts[0];
    expect(receipt.delivered_at).toBeTruthy();
    expect(receipt.total).toBe(5000);
  });
});
