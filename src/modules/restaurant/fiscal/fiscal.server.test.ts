/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * TRA Fiscal / VFD Integration Foundation — core state machine tests.
 *
 * requestFiscalization() never calls assertCapability itself (fiscalization
 * is always driven by an already-authorized sales flow — see
 * sales/receipts.server.ts's attachFiscalStatus), so these tests exercise it
 * directly against a fake Supabase client mirroring the shape of
 * standalone/db/migrations/0025_fiscal_foundation.sql.
 */
import { describe, expect, it, vi } from "vitest";
import { requestFiscalization } from "./fiscal.server";
import { createTestFiscalAdapter } from "./providers/testAdapter.server";
import { fiscalIdempotencyKey, operatorMessageForState, FISCAL_STATES } from "./contracts";

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const USER = "22222222-2222-2222-2222-222222222222";
const LOCATION_A = "loc-a";
const LOCATION_B = "loc-b";
const ORDER = "order-1";

function fakeDb(seed: {
  orders: any[];
  configs: any[];
  devices: any[];
  orderItems: any[];
  payments: any[];
}) {
  const tables: Record<string, any[]> = {
    restaurant_orders: seed.orders,
    restaurant_fiscal_configurations: seed.configs,
    restaurant_fiscal_devices: seed.devices,
    restaurant_order_items: seed.orderItems,
    restaurant_payments: seed.payments,
    restaurant_fiscal_receipts: [],
    restaurant_fiscal_receipt_items: [],
    restaurant_fiscal_submissions: [],
    restaurant_fiscal_acknowledgements: [],
  };
  let seq = 0;

  function violatesUnique(table: string, row: any): boolean {
    if (table === "restaurant_fiscal_receipts") {
      return tables[table]!.some(
        (r) => r.tenant_id === row.tenant_id && r.order_id === row.order_id,
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
      gte: (col: string, val: string | number) => {
        filtered = filtered.filter((r) => r[col] >= val);
        return api;
      },
      lte: (col: string, val: string | number) => {
        filtered = filtered.filter((r) => r[col] <= val);
        return api;
      },
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
        return {
          select: () => ({ single: async () => ({ data: stored, error: null }) }),
        };
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
      upsert: (row: any, _opts?: any) => {
        const existing = rows.find(
          (r) => r.tenant_id === row.tenant_id && r.fiscal_receipt_id === row.fiscal_receipt_id,
        );
        if (existing) Object.assign(existing, row);
        else rows.push({ id: `${table}-${++seq}`, ...row });
        return {
          select: () => ({ single: async () => ({ data: existing ?? rows.at(-1), error: null }) }),
        };
      },
      delete: () => ({
        eq: () => ({ eq: async () => ({ data: null, error: null }) }),
      }),
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return api;
  }

  const rpc = vi.fn(async (fn: string) => {
    if (fn === "restaurant_next_document_number")
      return { data: `FSC-2026-${String(++seq).padStart(5, "0")}` };
    return { data: null };
  });

  return { from, rpc };
}

function order(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: ORDER,
    tenant_id: TENANT,
    property_id: null,
    location_id: LOCATION_A,
    currency: "TZS",
    subtotal: 36000,
    tax_total: 0,
    total: 36000,
    ...overrides,
  };
}

function activeConfig(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "config-1",
    tenant_id: TENANT,
    location_id: LOCATION_A,
    business_name: "LexiBite Demo Kitchen",
    tin: "100-000-000",
    vrn: null,
    environment: "test",
    activation_state: "active",
    ...overrides,
  };
}

function lineItems() {
  return [
    {
      id: "item-1",
      order_id: ORDER,
      description: "Classic Chicken Burger",
      quantity: 2,
      unit_price: 18000,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 36000,
      status: "ready",
    },
  ];
}

describe("requestFiscalization", () => {
  it("returns not_required when the outlet has no fiscal configuration", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(db as any, USER, {
      tenantId: TENANT,
      orderId: ORDER,
    });
    expect(status.state).toBe("not_required");
  });

  it("returns not_required when the configuration is inactive — never blocks the sale", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig({ activation_state: "inactive" })],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(db as any, USER, {
      tenantId: TENANT,
      orderId: ORDER,
    });
    expect(status.state).toBe("not_required");
  });

  it("SUCCESS: fiscalizes Classic Chicken Burger x2 through the test adapter end to end", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [
        {
          id: "dev-1",
          tenant_id: TENANT,
          fiscal_configuration_id: "config-1",
          device_serial: "EFD-0001",
        },
      ],
      orderItems: lineItems(),
      payments: [{ method: "cash" }],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("success"),
    );
    expect(status.state).toBe("fiscalized");
    expect(status.fiscalReceiptNumber).toBeTruthy();
    expect(status.operatorMessage).toBe("Fiscal receipt issued.");

    const receipts = (db as any).from("restaurant_fiscal_receipts");
    const rows = await receipts.eq("tenant_id", TENANT).eq("order_id", ORDER);
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0].order_id).toBe(ORDER);
  });

  it("DUPLICATE: a second call for the same order never creates a second fiscal receipt", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const adapter = createTestFiscalAdapter("success");
    const first = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      adapter,
    );
    const second = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      adapter,
    );

    expect(first.state).toBe("fiscalized");
    expect(second.state).toBe("fiscalized");
    expect(second.fiscalReceiptNumber).toBe(first.fiscalReceiptNumber);

    const rows = await (db as any)
      .from("restaurant_fiscal_receipts")
      .eq("tenant_id", TENANT)
      .eq("order_id", ORDER);
    expect(rows.data).toHaveLength(1);
  });

  it("TIMEOUT: payment/order truth is untouched; fiscal state becomes retryable, never falsely 'fiscalized'", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("timeout"),
    );
    expect(status.state).not.toBe("fiscalized");
    expect(["retry_required", "network_error", "failed"]).toContain(status.state);
    expect(status.operatorMessage).not.toMatch(/timeout|HTTP|TRA|adapter/i);

    // Order row itself was never written to by requestFiscalization.
    const orders = await (db as any).from("restaurant_orders").eq("id", ORDER);
    expect(orders.data[0]).toMatchObject({ total: 36000 });
  });

  it("REJECTION: state is rejected, reason stays internal, operator sees only actionable language", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("rejection"),
    );
    expect(status.state).toBe("rejected");
    expect(status.operatorMessage).toBe("Fiscal receipt was rejected. Contact a manager.");
    expect(status.operatorMessage).not.toMatch(/validation|payload|provider/i);

    const rows = await (db as any)
      .from("restaurant_fiscal_receipts")
      .eq("tenant_id", TENANT)
      .eq("order_id", ORDER);
    expect(rows.data[0].last_error_message).toMatch(/rejection/i);
  });

  it("AUTHENTICATION_FAILURE: classified distinctly, never surfaced as a generic failure", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("authentication_failure"),
    );
    expect(status.state).toBe("authentication_error");
  });

  it("NETWORK_FAILURE: classified as network_error, retry-eligible", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("network_failure"),
    );
    expect(status.state).toBe("network_error");
  });

  it("MALFORMED_RESPONSE: never crashes the request, degrades to a retryable state", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("malformed_response"),
    );
    expect(status.state).toBe("retry_required");
  });

  it("SEQUENCE/CONCURRENCY: two callers racing on the same order converge on one fiscal receipt via the unique constraint", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig()],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const adapter = createTestFiscalAdapter("success");
    const [a, b] = await Promise.all([
      requestFiscalization(db as any, USER, { tenantId: TENANT, orderId: ORDER }, adapter),
      requestFiscalization(db as any, USER, { tenantId: TENANT, orderId: ORDER }, adapter),
    ]);
    const rows = await (db as any)
      .from("restaurant_fiscal_receipts")
      .eq("tenant_id", TENANT)
      .eq("order_id", ORDER);
    expect(rows.data).toHaveLength(1);
    expect([a.state, b.state]).toContain("fiscalized");
  });

  it("MULTI-OUTLET: outlet A's fiscal configuration never applies to outlet B", async () => {
    const orderB = order({ id: "order-b", location_id: LOCATION_B });
    const db = fakeDb({
      orders: [order(), orderB],
      configs: [
        activeConfig({ location_id: LOCATION_A }),
        activeConfig({ id: "config-2", location_id: LOCATION_B, activation_state: "inactive" }),
      ],
      devices: [],
      orderItems: [...lineItems(), { ...lineItems()[0], id: "item-b", order_id: "order-b" }],
      payments: [],
    });
    const a = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("success"),
    );
    const b = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: "order-b" },
      createTestFiscalAdapter("success"),
    );
    expect(a.state).toBe("fiscalized");
    expect(b.state).toBe("not_required");
  });

  it("MULTI-TENANT: a fiscal receipt is scoped to its own tenant_id, never leaks across tenants", async () => {
    const db = fakeDb({
      orders: [order(), order({ id: "order-other", tenant_id: OTHER_TENANT })],
      configs: [activeConfig(), activeConfig({ id: "config-other", tenant_id: OTHER_TENANT })],
      devices: [],
      orderItems: [
        ...lineItems(),
        { ...lineItems()[0], id: "item-other", order_id: "order-other" },
      ],
      payments: [],
    });
    await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      createTestFiscalAdapter("success"),
    );
    await requestFiscalization(
      db as any,
      USER,
      { tenantId: OTHER_TENANT, orderId: "order-other" },
      createTestFiscalAdapter("success"),
    );

    const tenantARows = await (db as any)
      .from("restaurant_fiscal_receipts")
      .eq("tenant_id", TENANT);
    const tenantBRows = await (db as any)
      .from("restaurant_fiscal_receipts")
      .eq("tenant_id", OTHER_TENANT);
    expect(tenantARows.data).toHaveLength(1);
    expect(tenantBRows.data).toHaveLength(1);
    expect(tenantARows.data[0].id).not.toBe(tenantBRows.data[0].id);
  });

  it("CONFIGURATION_ERROR: no adapter available for the environment never fabricates a fiscalized outcome", async () => {
    const db = fakeDb({
      orders: [order()],
      configs: [activeConfig({ environment: "production" })],
      devices: [],
      orderItems: lineItems(),
      payments: [],
    });
    const status = await requestFiscalization(
      db as any,
      USER,
      { tenantId: TENANT, orderId: ORDER },
      null,
    );
    expect(status.state).toBe("configuration_error");
    expect(status.fiscalReceiptNumber).toBeNull();
  });
});

describe("operatorMessageForState", () => {
  it("never leaks technical detail for any state (spec section 18/27/42)", () => {
    const forbidden = /HTTP|JSON|TLS|OAuth|certificate|stack trace|endpoint|provider|adapter/i;
    for (const state of FISCAL_STATES) {
      expect(operatorMessageForState(state)).not.toMatch(forbidden);
    }
  });
});

describe("fiscalIdempotencyKey", () => {
  it("is deterministic per order — same order, same key, every time", () => {
    expect(fiscalIdempotencyKey("order-1")).toBe(fiscalIdempotencyKey("order-1"));
    expect(fiscalIdempotencyKey("order-1")).not.toBe(fiscalIdempotencyKey("order-2"));
  });
});
