/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * TRA VFD orchestration in fiscal.server.ts — categories E (concurrency/
 * numbering), F (offline/retry), G (Z-report authorization), H (security:
 * property/tenant scope on the new registration/connection/Z-report
 * functions). The real TRA HTTP/crypto layer is mocked here (already
 * covered directly by traClient.server.test.ts and traEfd.server.test.ts);
 * this file proves fiscal.server.ts's OWN wiring — the one-at-a-time queue
 * guard, numbering allocation/freeze, retry-with-original-payload, and that
 * every new capability-gated entry point is actually gated.
 *
 * Numbering uniqueness under REAL concurrent Postgres writers is guaranteed
 * by restaurant_fiscal_next_counter()'s atomic INSERT ... ON CONFLICT ...
 * RETURNING (migration 0031) — the same pattern already relied on for
 * restaurant_next_document_number(). A synchronous in-memory mock cannot
 * meaningfully exercise real database row-locking, so this file proves the
 * allocator is called correctly and produces distinct values across calls,
 * not a race at the Postgres level (that guarantee lives in the SQL itself).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./providers/traEfd.server", () => ({
  createTraEfdAdapter: vi.fn(),
  ensureTraAccessToken: vi.fn(),
  registerTraVfd: vi.fn(),
  submitTraZReport: vi.fn(),
}));

import * as traEfd from "./providers/traEfd.server";
import {
  getFiscalRegistrationStatus,
  registerFiscalVfd,
  requestFiscalization,
  submitZReportForBusinessDate,
  testFiscalConnection,
} from "./fiscal.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";
const USER_A1_GM = "10000000-user-0000-0000-0000000000a1";
const USER_A2_GM = "10000000-user-0000-0000-0000000000a2";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

function makeFixture() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_A1_GM, role: "general_manager", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_A2_GM, role: "general_manager", property_id: PROPERTY_A2 },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const orders: any[] = [];
  const configs: any[] = [];
  const devices: any[] = [];
  const orderItems: any[] = [];
  const payments: any[] = [];
  const receipts: any[] = [];
  const submissions: any[] = [];
  const acknowledgements: any[] = [];
  const zReports: any[] = [];
  const counters = new Map<string, number>();
  let seq = 0;

  function tables(): Record<string, any[]> {
    return {
      restaurant_members: members,
      restaurant_locations: locations,
      restaurant_orders: orders,
      restaurant_fiscal_configurations: configs,
      restaurant_fiscal_devices: devices,
      restaurant_order_items: orderItems,
      restaurant_payments: payments,
      restaurant_tax_rules: [],
      restaurant_fiscal_receipts: receipts,
      restaurant_fiscal_receipt_items: [],
      restaurant_fiscal_submissions: submissions,
      restaurant_fiscal_acknowledgements: acknowledgements,
      restaurant_fiscal_z_reports: zReports,
    };
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push((r: any) => r[col] !== val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filters.push((r: any) => set.has(r[col]));
        return api;
      },
      gte(col: string, val: string) {
        filters.push((r: any) => r[col] >= val);
        return api;
      },
      lte: () => api,
      order: () => api,
      limit: () => api,
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      upsert(row: any, opts?: { onConflict?: string }) {
        op = "upsert";
        payload = { row, opts };
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rows(): any[] {
      return tables()[table] ?? (tables()[table] = []);
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (op === "insert") {
        const stored = {
          id: `${table}-${++seq}`,
          attempt_count: 0,
          updated_at: new Date().toISOString(),
          ...payload,
        };
        rows().push(stored);
        return { data: stored, error: null };
      }
      if (op === "upsert") {
        const { row, opts } = payload;
        const keyCols = (opts?.onConflict ?? "id").split(",");
        const existing = rows().find((r) => keyCols.every((c: string) => r[c] === row[c]));
        if (existing) Object.assign(existing, row);
        else rows().push({ id: `${table}-${++seq}`, ...row });
        return { data: existing ?? rows().at(-1), error: null };
      }
      if (op === "update") {
        const targets = rows().filter((r) => filters.every((f) => f(r)));
        for (const r of targets)
          Object.assign(r, payload, { updated_at: new Date().toISOString() });
        return { data: targets[0] ?? null, error: targets[0] ? null : { message: "not found" } };
      }
      if (op === "delete") {
        const remaining = rows().filter((r) => !filters.every((f) => f(r)));
        tables()[table] = remaining;
        return { data: null, error: null };
      }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (mode === "list") return { data: matched, error: null };
      return {
        data: matched[0] ?? null,
        error: mode === "single" && !matched[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  const rpc = vi.fn(async (fn: string, args: any) => {
    if (fn === "has_any_role") return { data: false, error: null };
    if (fn === "restaurant_fiscal_next_counter") {
      const key = `${args._fiscal_config}:${args._counter_type}:${args._period_key}`;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { data: next, error: null };
    }
    return { data: null, error: null };
  });

  return {
    supabase: { from, rpc },
    members,
    orders,
    configs,
    devices,
    orderItems,
    payments,
    receipts,
    zReports,
  };
}

function seedActiveOutlet(
  fx: ReturnType<typeof makeFixture>,
  orderId: string,
  locationId: string,
  propertyId: string,
) {
  fx.configs.push({
    id: `cfg-${locationId}`,
    tenant_id: TENANT_A,
    property_id: propertyId,
    location_id: locationId,
    business_name: "LexiBite Demo",
    tin: "123-456-789",
    vrn: "VRN1",
    environment: "test",
    activation_state: "active",
  });
  fx.devices.push({
    tenant_id: TENANT_A,
    fiscal_configuration_id: `cfg-${locationId}`,
    device_serial: `EFD-${locationId}`,
    registration_info: { regId: "REG1", efdSerial: "EFD001", receiptCode: "RC" },
  });
  fx.orders.push({
    id: orderId,
    tenant_id: TENANT_A,
    property_id: propertyId,
    location_id: locationId,
    currency: "TZS",
    subtotal: 30508.47,
    tax_total: 5491.53,
    total: 36000,
  });
  fx.orderItems.push({
    id: `item-${orderId}`,
    order_id: orderId,
    description: "Classic Chicken Burger",
    quantity: 2,
    unit_price: 18000,
    tax_rate: 18,
    tax_amount: 5491.53,
    line_total: 36000,
    status: "ready",
    tax_rule_id: null,
  });
  fx.payments.push({ order_id: orderId, method: "cash", amount: 36000 });
}

describe("requestFiscalization — real TRA path orchestration (categories E/F)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (traEfd.ensureTraAccessToken as any).mockResolvedValue({ token: "valid-token" });
  });

  it("E: two different orders under the same VFD each get a distinct GC (allocator produces unique, monotonic values)", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    fx.orders.push({ ...fx.orders[0], id: "order-2" });
    fx.orderItems.push({ ...fx.orderItems[0], id: "item-order-2", order_id: "order-2" });
    fx.payments.push({ order_id: "order-2", method: "cash", amount: 36000 });

    const adapter = {
      providerCode: "tra_efd",
      environment: "test" as const,
      verifyConnectivity: vi.fn(),
      submitReceipt: vi.fn().mockResolvedValue({
        outcome: "success",
        fiscalReceiptNumber: "RC1",
        verificationCode: null,
        zNumber: "20260904",
        acknowledgedAt: new Date().toISOString(),
        signedXml: "<xml/>",
      }),
    };
    (traEfd.createTraEfdAdapter as any).mockReturnValue(adapter);

    await requestFiscalization({ ...fx.supabase } as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-1",
    });
    await requestFiscalization({ ...fx.supabase } as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-2",
    });

    const r1 = fx.receipts.find((r) => r.order_id === "order-1");
    const r2 = fx.receipts.find((r) => r.order_id === "order-2");
    expect(r1.gc_number).not.toBe(r2.gc_number);
    expect(new Set([r1.gc_number, r2.gc_number]).size).toBe(2);
  });

  it("E: a receipt already 'submitting' for the same VFD blocks a new one from starting — never two simultaneous TRA calls", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    fx.orders.push({ ...fx.orders[0], id: "order-2" });
    fx.orderItems.push({ ...fx.orderItems[0], id: "item-order-2", order_id: "order-2" });
    fx.payments.push({ order_id: "order-2", method: "cash", amount: 36000 });
    // Simulate order-1's receipt already mid-flight.
    fx.receipts.push({
      id: "rcpt-inflight",
      tenant_id: TENANT_A,
      order_id: "order-1",
      location_id: LOC_A1,
      fiscal_configuration_id: `cfg-${LOC_A1}`,
      state: "submitting",
      updated_at: new Date().toISOString(),
      attempt_count: 1,
    });

    const submitReceipt = vi.fn();
    (traEfd.createTraEfdAdapter as any).mockReturnValue({
      providerCode: "tra_efd",
      environment: "test",
      verifyConnectivity: vi.fn(),
      submitReceipt,
    });

    const status = await requestFiscalization(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-2",
    });
    expect(status.state).toBe("retry_required");
    expect(submitReceipt).not.toHaveBeenCalled();
  });

  it("F: a network failure preserves the exact signed XML and numbering; the retry resends the SAME bytes, never regenerated", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);

    const submitReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "network_error",
        errorClass: "network",
        reason: "TRA unreachable",
        signedXml: "<EFDMS><RCT>FROZEN-PAYLOAD</RCT></EFDMS>",
      })
      .mockResolvedValueOnce({
        outcome: "success",
        fiscalReceiptNumber: "RC00000001",
        verificationCode: null,
        zNumber: "20260904",
        acknowledgedAt: new Date().toISOString(),
        signedXml: "<EFDMS><RCT>FROZEN-PAYLOAD</RCT></EFDMS>",
      });
    (traEfd.createTraEfdAdapter as any).mockReturnValue({
      providerCode: "tra_efd",
      environment: "test",
      verifyConnectivity: vi.fn(),
      submitReceipt,
    });

    const first = await requestFiscalization(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-1",
    });
    expect(first.state).toBe("network_error");
    const afterFirst = fx.receipts.find((r) => r.order_id === "order-1");
    expect(afterFirst.original_request_xml).toBe("<EFDMS><RCT>FROZEN-PAYLOAD</RCT></EFDMS>");
    const gcAfterFirst = afterFirst.gc_number;
    const rctDateAfterFirst = afterFirst.rct_date;

    const second = await requestFiscalization(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-1",
    });
    expect(second.state).toBe("fiscalized");

    // The second call to the adapter must have received the EXACT frozen XML.
    const secondCallInput = submitReceipt.mock.calls[1][0];
    expect(secondCallInput.existingSignedXml).toBe("<EFDMS><RCT>FROZEN-PAYLOAD</RCT></EFDMS>");
    expect(secondCallInput.numbering.gc).toBe(gcAfterFirst);
    expect(secondCallInput.numbering.rctDate).toBe(rctDateAfterFirst);

    const afterSecond = fx.receipts.find((r) => r.order_id === "order-1");
    expect(afterSecond.gc_number).toBe(gcAfterFirst); // never re-allocated
  });

  it("no registration on the device -> configuration_error, GC is never burned, TRA is never called", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    fx.devices[0].registration_info = {}; // not registered

    const submitReceipt = vi.fn();
    (traEfd.createTraEfdAdapter as any).mockReturnValue({
      providerCode: "tra_efd",
      environment: "test",
      verifyConnectivity: vi.fn(),
      submitReceipt,
    });

    const status = await requestFiscalization(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-1",
    });
    expect(status.state).toBe("configuration_error");
    expect(submitReceipt).not.toHaveBeenCalled();
    const receipt = fx.receipts.find((r) => r.order_id === "order-1");
    expect(receipt.gc_number).toBeFalsy();
  });

  it("token resolution failure maps to the correct fiscal state without ever calling submitReceipt", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    (traEfd.ensureTraAccessToken as any).mockResolvedValue({
      error: "TRA_AUTHENTICATION_FAILED",
      message: "Bad credentials",
    });
    const submitReceipt = vi.fn();
    (traEfd.createTraEfdAdapter as any).mockReturnValue({
      providerCode: "tra_efd",
      environment: "test",
      verifyConnectivity: vi.fn(),
      submitReceipt,
    });

    const status = await requestFiscalization(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      orderId: "order-1",
    });
    expect(status.state).toBe("authentication_error");
    expect(submitReceipt).not.toHaveBeenCalled();
  });
});

describe("H: property/tenant scope on registration, connection test, registration status, Z-report submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registerFiscalVfd: A1-GM can register A1's outlet; A2 is DENIED", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    seedActiveOutlet(fx, "order-2", LOC_A2, PROPERTY_A2);
    (traEfd.registerTraVfd as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "OK",
      regId: "REG1",
      efdSerial: "EFD1",
      uin: null,
      receiptCode: "RC",
      taxOffice: null,
      region: null,
    });

    await expect(
      registerFiscalVfd(fx.supabase as any, USER_A1_GM, { tenantId: TENANT_A, locationId: LOC_A1 }),
    ).resolves.toMatchObject({ regId: "REG1" });
    await expect(
      registerFiscalVfd(fx.supabase as any, USER_A1_GM, { tenantId: TENANT_A, locationId: LOC_A2 }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("testFiscalConnection: cross-tenant caller is denied outright, never reaches ensureTraAccessToken", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    await expect(
      testFiscalConnection(fx.supabase as any, USER_B1_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/requires one of/);
    expect(traEfd.ensureTraAccessToken).not.toHaveBeenCalled();
  });

  it("getFiscalRegistrationStatus never returns username/password/token — only safe derived fields", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    const status = await getFiscalRegistrationStatus(fx.supabase as any, USER_A1_GM, {
      tenantId: TENANT_A,
      locationId: LOC_A1,
    });
    expect(status).not.toHaveProperty("username");
    expect(status).not.toHaveProperty("password");
    expect(status).not.toHaveProperty("accessToken");
    expect(status).not.toHaveProperty("token");
    expect(status.regId).toBe("REG1");
  });

  it("getFiscalRegistrationStatus: A2-GM cannot read A1's registration status", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    await expect(
      getFiscalRegistrationStatus(fx.supabase as any, USER_A2_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("submitZReportForBusinessDate: A1-GM can submit for A1; A2 is DENIED", async () => {
    const fx = makeFixture();
    seedActiveOutlet(fx, "order-1", LOC_A1, PROPERTY_A1);
    (traEfd.submitTraZReport as any).mockResolvedValue({
      ackCode: "0",
      ackMessage: "OK",
      zNumber: 1,
    });

    const businessDate = new Date().toISOString().slice(0, 10);
    await expect(
      submitZReportForBusinessDate(fx.supabase as any, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate,
      }),
    ).resolves.toMatchObject({ ackCode: "0" });

    await expect(
      submitZReportForBusinessDate(fx.supabase as any, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate,
      }),
    ).rejects.toThrow(/not granted to you at this location/);
  });
});
