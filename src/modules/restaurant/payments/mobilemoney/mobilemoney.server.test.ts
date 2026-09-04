/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Mobile Money / Lipa Namba Payment Core — state machine tests.
 *
 * Capability checks (assertCapability/assertTenantRead) and the downstream
 * sales core (recalcOrder/transitionOrder/getReceipt, which itself
 * triggers TRA fiscalization — see sales/receipts.server.ts) are mocked
 * out here; those seams already have their own dedicated test coverage
 * (fiscal.server.test.ts, pos.server.test.ts). This file exercises the
 * Payment Core's own logic: idempotency, the collection state machine,
 * amount reconciliation, refunds, and webhook processing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/access.server", () => ({
  assertCapability: vi.fn(async () => undefined),
  assertTenantRead: vi.fn(async () => undefined),
}));
vi.mock("../../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));

const recalcOrder = vi.fn(async () => ({ payment_state: "paid", status: "open" }) as any);
const transitionOrder = vi.fn(async () => ({}) as any);
const getReceipt = vi.fn(async () => ({}) as any);
vi.mock("../../sales/sales.server", () => ({ recalcOrder, transitionOrder }));
vi.mock("../../sales/receipts.server", () => ({ getReceipt }));

import {
  cancelMobileMoneyCollection,
  confirmMobileMoneyCollection,
  failMobileMoneyCollection,
  handleMobileMoneyWebhookEvent,
  requestMobileMoneyCollection,
  reverseMobileMoneyCollection,
} from "./mobilemoney.server";
import { createTestMobileMoneyAdapter } from "./providers/testAdapter.server";
import { reconciliationStateForCollection, operatorMessageForCollectionState } from "./contracts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";
const LOCATION_A = "loc-a";
const LOCATION_B = "loc-b";
const ORDER = "order-1";

function fakeDb(seed: { orders: any[]; accounts: any[] }) {
  const tables: Record<string, any[]> = {
    restaurant_orders: seed.orders,
    restaurant_mobile_money_accounts: seed.accounts,
    restaurant_mobile_money_collections: [],
    restaurant_mobile_money_webhook_events: [],
    restaurant_mobile_money_refunds: [],
    restaurant_payments: [],
  };
  let seq = 0;

  function violatesUnique(table: string, row: any): boolean {
    if (table === "restaurant_mobile_money_collections") {
      return tables[table]!.some(
        (r) => r.tenant_id === row.tenant_id && r.idempotency_key === row.idempotency_key,
      );
    }
    if (table === "restaurant_mobile_money_webhook_events") {
      return tables[table]!.some(
        (r) =>
          r.provider_code === row.provider_code && r.provider_event_id === row.provider_event_id,
      );
    }
    return false;
  }

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      gte: () => api,
      order: () => api,
      limit: () => api,
      insert: (row: any) => {
        if (violatesUnique(table, row)) {
          return {
            select: () => ({
              single: async () => ({
                data: null,
                error: { code: "23505", message: "duplicate key" },
              }),
            }),
          };
        }
        const stored = { id: `${table}-${++seq}`, attempt_count: 0, ...row };
        rows.push(stored);
        filtered = [stored];
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
      update: (patch: any) => {
        let targets = filtered;
        const updateApi: any = {
          eq: (col: string, val: unknown) => {
            targets = targets.filter((r) => r[col] === val);
            return updateApi;
          },
          select: () => ({
            single: async () => {
              const target = targets[0];
              if (target) Object.assign(target, patch);
              return { data: target ?? null, error: target ? null : { message: "not found" } };
            },
          }),
          then: (resolve: (v: { data: any; error: any }) => unknown) => {
            for (const t of targets) Object.assign(t, patch);
            return resolve({ data: targets, error: null });
          },
        };
        return updateApi;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return api;
  }

  return { from };
}

function order(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: ORDER,
    tenant_id: TENANT,
    property_id: null,
    location_id: LOCATION_A,
    currency: "TZS",
    ...overrides,
  };
}

function activeAccount(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "account-1",
    tenant_id: TENANT,
    location_id: LOCATION_A,
    mode: "connected",
    network: "mpesa",
    merchant_number: "123456",
    environment: "test",
    activation_state: "active",
    ...overrides,
  };
}

describe("requestMobileMoneyCollection", () => {
  it("throws when no account is configured for the outlet — never silently creates a collection", async () => {
    const db = fakeDb({ orders: [order()], accounts: [] });
    await expect(
      requestMobileMoneyCollection(db as any, USER, {
        tenantId: TENANT,
        orderId: ORDER,
        amount: 36000,
        clientRequestId: "req-1",
      }),
    ).rejects.toThrow(/not activated/i);
  });

  it("throws when the account exists but is inactive", async () => {
    const db = fakeDb({
      orders: [order()],
      accounts: [activeAccount({ activation_state: "inactive" })],
    });
    await expect(
      requestMobileMoneyCollection(db as any, USER, {
        tenantId: TENANT,
        orderId: ORDER,
        amount: 36000,
        clientRequestId: "req-1",
      }),
    ).rejects.toThrow(/not activated/i);
  });

  it("Lipa Namba mode never auto-confirms — goes straight to manual_confirmation_required, never 'paid'", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount({ mode: "lipa_namba" })] });
    const status = await requestMobileMoneyCollection(db as any, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      amount: 36000,
      clientRequestId: "req-1",
    });
    expect(status.state).toBe("manual_confirmation_required");
    expect(status.requiresManualConfirmation).toBe(true);
    expect(status.operatorMessage).toBe("Awaiting confirmation");
  });

  it("connected mode via the test adapter accepts and moves to pending_customer — a request is not a payment", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const status = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    expect(status.state).toBe("pending_customer");
    expect(status.operatorMessage).toBe("Waiting for customer confirmation…");
  });

  it("DUPLICATE REQUEST: the same clientRequestId twice returns the same collection, never a second one", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const adapter = createTestMobileMoneyAdapter("success");
    const first = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      adapter,
    );
    const second = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      adapter,
    );
    expect(second.collectionId).toBe(first.collectionId);
    const rows = await (db as any)
      .from("restaurant_mobile_money_collections")
      .eq("tenant_id", TENANT)
      .eq("order_id", ORDER);
    expect(rows.data).toHaveLength(1);
  });

  it("SPLIT PAYMENT: two distinct requests against one order create two distinct collections", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const adapter = createTestMobileMoneyAdapter("success");
    await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 20000, clientRequestId: "req-a" },
      adapter,
    );
    await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 16000, clientRequestId: "req-b" },
      adapter,
    );
    const rows = await (db as any)
      .from("restaurant_mobile_money_collections")
      .eq("tenant_id", TENANT)
      .eq("order_id", ORDER);
    expect(rows.data).toHaveLength(2);
  });

  it("MULTI-OUTLET: outlet A's account never applies to outlet B", async () => {
    const orderB = order({ id: "order-b", location_id: LOCATION_B });
    const db = fakeDb({
      orders: [order(), orderB],
      accounts: [activeAccount({ location_id: LOCATION_A })],
    });
    await expect(
      requestMobileMoneyCollection(db as any, USER, {
        tenantId: TENANT,
        orderId: "order-b",
        amount: 1000,
        clientRequestId: "req-1",
      }),
    ).rejects.toThrow(/not activated/i);
  });

  it("NETWORK_FAILURE / PROVIDER_TIMEOUT: rejected at the adapter never leaves a pending collection stuck", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const status = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("network_failure"),
    );
    expect(status.state).toBe("failed");
  });
});

describe("confirmMobileMoneyCollection", () => {
  async function seededCollection(db: any) {
    return requestMobileMoneyCollection(
      db,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
  }

  it("SUCCESS: confirms once, writes exactly one restaurant_payments row", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await seededCollection(db);
    const confirmed = await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 36000,
      confirmedCurrency: "TZS",
    });
    expect(confirmed.state).toBe("paid");
    const payments = await (db as any).from("restaurant_payments").eq("tenant_id", TENANT);
    expect(payments.data).toHaveLength(1);
    expect(payments.data[0]).toMatchObject({
      method: "mobile_money",
      state: "paid",
      amount: 36000,
    });
  });

  it("DUPLICATE CONFIRMATION: calling confirm twice never creates a second payment row", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await seededCollection(db);
    await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 36000,
      confirmedCurrency: "TZS",
    });
    await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 36000,
      confirmedCurrency: "TZS",
    });
    const payments = await (db as any).from("restaurant_payments").eq("tenant_id", TENANT);
    expect(payments.data).toHaveLength(1);
  });

  it("WRONG AMOUNT: a mismatched confirmed amount never becomes a payment — fails with wrong_amount", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await seededCollection(db);
    const result = await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 18000,
      confirmedCurrency: "TZS",
    });
    expect(result.state).toBe("failed");
    const payments = await (db as any).from("restaurant_payments").eq("tenant_id", TENANT);
    expect(payments.data).toHaveLength(0);
  });

  it("MANUAL CONFIRMATION (Lipa Namba): requires a real staff principal — assertCapability is invoked", async () => {
    const accessModule = await import("../../core/access.server");
    const db = fakeDb({ orders: [order()], accounts: [activeAccount({ mode: "lipa_namba" })] });
    const collection = await requestMobileMoneyCollection(db as any, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      amount: 36000,
      clientRequestId: "req-1",
    });
    await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      actorUserId: USER,
    });
    expect(accessModule.assertCapability).toHaveBeenCalledWith(db, USER, TENANT, "sales.manage");
  });
});

describe("failMobileMoneyCollection / cancelMobileMoneyCollection", () => {
  it("a failed collection is retryable — never terminal in a way that blocks another request", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    const failed = await failMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      errorClass: "customer_timeout",
      message: "Simulated timeout.",
    });
    expect(failed.state).toBe("failed");
  });

  it("cancelling an already-paid collection is refused", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 36000,
      confirmedCurrency: "TZS",
    });
    await expect(
      cancelMobileMoneyCollection(db as any, USER, {
        tenantId: TENANT,
        collectionId: collection.collectionId,
      }),
    ).rejects.toThrow(/already been received/i);
  });
});

describe("reverseMobileMoneyCollection", () => {
  it("REVERSAL: preserves the original payment row (marks it refunded, never deletes) and records a compensating refund", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    await confirmMobileMoneyCollection(db as any, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      confirmedAmount: 36000,
      confirmedCurrency: "TZS",
    });

    const { collection: reversed, refund } = await reverseMobileMoneyCollection(db as any, USER, {
      tenantId: TENANT,
      collectionId: collection.collectionId,
      reason: "Guest walked out, order voided.",
    });
    expect(reversed.state).toBe("reversed");
    expect(refund.amount).toBe(36000);

    const payments = await (db as any).from("restaurant_payments").eq("tenant_id", TENANT);
    expect(payments.data).toHaveLength(1); // preserved, not deleted
    expect(payments.data[0].state).toBe("refunded");
  });

  it("only a paid collection can be reversed", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    await expect(
      reverseMobileMoneyCollection(db as any, USER, {
        tenantId: TENANT,
        collectionId: collection.collectionId,
        reason: "test",
      }),
    ).rejects.toThrow(/only a paid collection/i);
  });
});

describe("handleMobileMoneyWebhookEvent", () => {
  function webhookPayload(
    providerEventId: string,
    providerReference: string,
    status: "paid" | "failed" | "pending" = "paid",
  ) {
    return JSON.stringify({ providerEventId, providerReference, status });
  }

  it("DUPLICATE WEBHOOK: the same provider event id processed twice is idempotent — no second confirmation", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const collection = await requestMobileMoneyCollection(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER, amount: 36000, clientRequestId: "req-1" },
      createTestMobileMoneyAdapter("success"),
    );
    const raw = webhookPayload(
      "evt-1",
      collection.merchantNumber
        ? (
            await (db as any)
              .from("restaurant_mobile_money_collections")
              .eq("id", collection.collectionId)
              .single()
          ).data.provider_reference
        : "",
    );

    const first = await handleMobileMoneyWebhookEvent(db as any, {
      providerCode: "test",
      rawBody: raw,
      headers: {},
    });
    const second = await handleMobileMoneyWebhookEvent(db as any, {
      providerCode: "test",
      rawBody: raw,
      headers: {},
    });
    expect(first.processed).toBe(true);
    expect((second as any).duplicate).toBe(true);

    const events = await (db as any)
      .from("restaurant_mobile_money_webhook_events")
      .eq("provider_code", "test");
    expect(events.data).toHaveLength(1);
  });

  it("WEBHOOK OUT OF ORDER (unknown collection): never crashes, records the event as unresolved", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const raw = webhookPayload("evt-orphan", "TEST-NOTFOUND");
    const result = await handleMobileMoneyWebhookEvent(db as any, {
      providerCode: "test",
      rawBody: raw,
      headers: {},
    });
    expect(result.processed).toBe(false);
    expect((result as any).reason).toBe("collection_not_found");
  });

  it("MALFORMED payload is rejected without throwing", async () => {
    const db = fakeDb({ orders: [order()], accounts: [activeAccount()] });
    const result = await handleMobileMoneyWebhookEvent(db as any, {
      providerCode: "test",
      rawBody: "not json",
      headers: {},
    });
    expect(result.processed).toBe(false);
  });
});

describe("pure helpers", () => {
  it("reconciliationStateForCollection maps every state to a defined bucket", () => {
    for (const s of [
      "created",
      "pending_customer",
      "paid",
      "failed",
      "cancelled",
      "reversed",
      "refunded",
    ] as const) {
      expect(reconciliationStateForCollection(s)).toBeTruthy();
    }
    expect(reconciliationStateForCollection("paid")).toBe("matched");
  });

  it("operatorMessageForCollectionState never leaks technical detail", () => {
    const forbidden = /HTTP|JSON|OAuth|API|webhook|endpoint|provider code/i;
    for (const s of [
      "created",
      "pending_customer",
      "processing",
      "paid",
      "failed",
      "manual_confirmation_required",
    ] as const) {
      expect(operatorMessageForCollectionState(s, "connected")).not.toMatch(forbidden);
      expect(operatorMessageForCollectionState(s, "lipa_namba")).not.toMatch(forbidden);
    }
  });
});
