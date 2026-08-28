/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * O11 — supplier communication for purchase orders.
 *
 * Exercises the REAL registered tenant scope checker (restaurant/intelligence/
 * provider.ts) and the REAL restaurant/core/access.server.ts capability gate
 * against a fake Supabase client, not a stub of the checks themselves — the
 * same methodology P10's actions.server.test.ts and receipts/delivery use.
 * The document renderer and outbound provider calls are mocked: document
 * content correctness is documents.test.ts's job, and a unit test must never
 * make a real network call to an email/WhatsApp provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../documents/builders/documents.server", () => ({
  renderDocument: vi.fn(async () => ({
    type: "purchase_order",
    title: "Purchase Order",
    number: "PO-2026-000001",
  })),
}));
vi.mock("../documents/rendering/toHtml", () => ({
  documentToHtml: vi.fn(() => "<html><body>Purchase Order PO-2026-000001</body></html>"),
}));
vi.mock("@/lib/notifications/adapters.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/adapters.server")>();
  return { ...actual, sendEmail: vi.fn(), sendWhatsApp: vi.fn() };
});

import { requestPoDelivery, listPoDeliveries } from "./poDelivery.server";
import { sendEmail, sendWhatsApp } from "@/lib/notifications/adapters.server";

// Registers the restaurant provider + its tenant scope checker as a side
// effect, exactly like the real app does via the admin/restaurant layout.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const MANAGER = "33333333-3333-3333-3333-333333333333";
const WAITER = "44444444-4444-4444-4444-444444444444";
const PO_ID = "55555555-5555-5555-5555-555555555555";
const SUPPLIER_ID = "66666666-6666-6666-6666-666666666666";

function purchaseOrderRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: PO_ID,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    status: "approved",
    document_number: "PO-2026-000001",
    reference: "PO-2026-000001",
    supplier_id: SUPPLIER_ID,
    currency: "TZS",
    total: 45000,
    correlation_id: "77777777-7777-7777-7777-777777777777",
    expected_at: null,
    ...overrides,
  };
}

function supplierRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: SUPPLIER_ID,
    tenant_id: TENANT_A,
    name: "ABC Foods",
    email: "purchasing@abcfoods.test",
    phone: "+255712345678",
    contact_name: "Jane Buyer",
    metadata: {},
    ...overrides,
  };
}

function matchesFilters(row: Record<string, any>, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([k, v]) => row[k] === v);
}

function makeFakeSupabase(opts: {
  purchaseOrder: Record<string, any> | null;
  supplier: Record<string, any> | null;
  restaurantMembers: Array<{ tenant_id: string; user_id: string; role: string }>;
  existingDeliveries?: Array<Record<string, any>>;
  failEventInsert?: boolean;
}) {
  const deliveries: Record<string, any>[] = (opts.existingDeliveries ?? []).map((d) => ({ ...d }));
  const documentEvents: Record<string, any>[] = [];
  const intelligenceEvents: Record<string, any>[] = [];
  let deliveryInsertCount = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;
    let mode: "single" | "maybeSingle" | "many" = "many";
    let countMode = false;

    const api: any = {
      select: (_cols?: string, selectOpts?: { count?: string; head?: boolean }) => {
        if (selectOpts?.head) countMode = true;
        return api;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      order: () => api,
      limit: () => api,
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      single: () => {
        mode = "single";
        return resolve();
      },
      maybeSingle: () => {
        mode = "maybeSingle";
        return resolve();
      },
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      if (op === "select") {
        if (countMode && table === "restaurant_po_deliveries") {
          const matches = deliveries.filter((d) => matchesFilters(d, filters));
          return { data: null, count: matches.length, error: null };
        }
        if (table === "restaurant_purchase_orders") {
          const match =
            opts.purchaseOrder && matchesFilters(opts.purchaseOrder, filters)
              ? opts.purchaseOrder
              : null;
          return { data: match, error: null };
        }
        if (table === "restaurant_suppliers") {
          const match =
            opts.supplier && matchesFilters(opts.supplier, filters) ? opts.supplier : null;
          return { data: match, error: null };
        }
        if (table === "restaurant_members") {
          return {
            data: opts.restaurantMembers.filter((m) => matchesFilters(m, filters)),
            error: null,
          };
        }
        if (table === "restaurant_po_deliveries") {
          const matches = deliveries.filter((d) => matchesFilters(d, filters));
          if (mode === "single")
            return {
              data: matches[0] ?? null,
              error: matches[0] ? null : { message: "not found" },
            };
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        if (table === "intelligence_events") {
          const matches = intelligenceEvents.filter((e) => matchesFilters(e, filters));
          return { data: matches[0] ?? null, error: null };
        }
        return { data: mode === "many" ? [] : null, error: null };
      }

      if (op === "update") {
        if (table === "restaurant_po_deliveries") {
          const row = deliveries.find((d) => matchesFilters(d, filters));
          if (row) {
            Object.assign(row, payload);
            return { data: mode === "many" ? [row] : row, error: null };
          }
        }
        return { data: null, error: null };
      }

      // insert
      if (table === "restaurant_po_deliveries") {
        deliveryInsertCount += 1;
        if (
          deliveries.some(
            (d) =>
              d.tenant_id === payload.tenant_id && d.idempotency_key === payload.idempotency_key,
          )
        ) {
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          };
        }
        const row = { id: `delivery-${deliveryInsertCount}`, ...payload };
        deliveries.push(row);
        return { data: row, error: null };
      }
      if (table === "restaurant_document_events") {
        documentEvents.push(payload);
        return { data: { id: "generated" }, error: null };
      }
      if (table === "intelligence_events") {
        if (opts.failEventInsert) return { data: null, error: { message: "boom" } };
        const id = `event-${intelligenceEvents.length + 1}`;
        intelligenceEvents.push({ id, ...payload });
        return { data: { id }, error: null };
      }
      return { data: { id: "generated" }, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
    getDeliveries: () => deliveries,
    getDocumentEvents: () => documentEvents,
    getIntelligenceEvents: () => intelligenceEvents,
    getDeliveryInsertCount: () => deliveryInsertCount,
  };
}

const OWNER_MEMBER = [{ tenant_id: TENANT_A, user_id: MANAGER, role: "purchasing_officer" }];

describe("requestPoDelivery — supplier communication", () => {
  beforeEach(() => {
    delete process.env["NOVA_EMAIL_WEBHOOK_URL"];
    delete process.env["TWILIO_ACCOUNT_SID"];
    delete process.env["TWILIO_AUTH_TOKEN"];
    delete process.env["WHATSAPP_FROM"];
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendWhatsApp).mockReset();
  });
  afterEach(() => {
    delete process.env["NOVA_EMAIL_WEBHOOK_URL"];
    delete process.env["TWILIO_ACCOUNT_SID"];
    delete process.env["TWILIO_AUTH_TOKEN"];
    delete process.env["WHATSAPP_FROM"];
  });

  it("sends the email using the canonical document render and records a sent attempt", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: true, provider: "email", reference: "msg-1" });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "email-attempt-1",
    });

    expect(result.status).toBe("sent");
    expect(result.provider).toBe("email");
    expect(result.providerReference).toBe("msg-1");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendEmail).mock.calls[0][0];
    expect(call.html).toContain("PO-2026-000001");
    expect(call.subject).toContain("PO-2026-000001");

    expect(fake.getDeliveries()).toHaveLength(1);
    expect(fake.getDeliveries()[0].status).toBe("sent");
    expect(fake.getDocumentEvents()).toHaveLength(1);
    expect(fake.getDocumentEvents()[0].action).toBe("emailed");

    const eventTypes = fake.getIntelligenceEvents().map((e) => e.event_type);
    expect(eventTypes).toEqual([
      "restaurant.purchase.order.communication.requested",
      "restaurant.purchase.order.communication.sent",
    ]);
  });

  it("sends WhatsApp via the configured provider, never claiming 'delivered'", async () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC123";
    process.env["TWILIO_AUTH_TOKEN"] = "secret";
    process.env["WHATSAPP_FROM"] = "+15550001111";
    vi.mocked(sendWhatsApp).mockResolvedValueOnce({
      ok: true,
      provider: "twilio_whatsapp",
      reference: "SM1",
    });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "whatsapp",
      recipient: "+255712345678",
      idempotencyKey: "wa-attempt-1",
    });

    expect(result.status).toBe("sent");
    expect(result.provider).toBe("twilio_whatsapp");
    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+255712345678",
      expect.stringContaining("PO-2026-000001"),
    );
  });

  it("opens a manual share link (status 'shared', not 'sent') when WhatsApp has no provider configured", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "whatsapp",
      recipient: "+255712345678",
      idempotencyKey: "wa-attempt-2",
    });

    expect(result.status).toBe("shared");
    expect(result.failureCode).toBe("whatsapp_provider_not_configured");
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("fails cleanly (not fabricated success) when email has no provider configured", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "email-attempt-2",
    });

    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("email_provider_not_configured");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("captures a provider rejection as a failed, retryable attempt", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    vi.mocked(sendEmail).mockResolvedValueOnce({
      ok: false,
      provider: "email",
      reason: "rejected",
      error: "mailbox full",
    });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "email-attempt-3",
    });

    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("provider_rejected");
    expect(result.failureReason).toBe("mailbox full");
    expect(fake.getIntelligenceEvents().map((e) => e.event_type)).toContain(
      "restaurant.purchase.order.communication.failed",
    );
  });

  it("rejects an invalid email address before ever calling the provider", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow({ email: null }),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "not-an-email",
      idempotencyKey: "email-attempt-4",
    });

    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("invalid_email");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeated idempotency key returns the same attempt without sending twice", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "email", reference: "msg-x" });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const input = {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email" as const,
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "same-key",
    };

    const first = await requestPoDelivery(fake.supabase, MANAGER, input);
    const second = await requestPoDelivery(fake.supabase, MANAGER, input);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(fake.getDeliveries()).toHaveLength(1);
  });

  it("a deliberate resend (new idempotency key) creates a second, distinguishable attempt", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "email", reference: "msg-y" });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const first = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "resend-key-1",
    });
    const second = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "resend-key-2",
    });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(second.attempt).toBe(first.attempt + 1);
    expect(second.duplicate).toBeUndefined();
    expect(fake.getDeliveries()).toHaveLength(2);
  });

  it("refuses to send a purchase order that has not been approved", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow({ status: "submitted" }),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      requestPoDelivery(fake.supabase, MANAGER, {
        tenantId: TENANT_A,
        purchaseOrderId: PO_ID,
        method: "email",
        recipient: "purchasing@abcfoods.test",
        idempotencyKey: "unapproved-1",
      }),
    ).rejects.toThrow(/only an approved purchase order/i);
    expect(fake.getDeliveries()).toHaveLength(0);
  });

  it("refuses a draft purchase order too — sending never doubles as issuing it", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow({ status: "draft" }),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      requestPoDelivery(fake.supabase, MANAGER, {
        tenantId: TENANT_A,
        purchaseOrderId: PO_ID,
        method: "email",
        idempotencyKey: "draft-1",
      }),
    ).rejects.toThrow(/only an approved purchase order/i);
  });

  it("fails cleanly when the order has no supplier on file", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow({ supplier_id: null }),
      supplier: null,
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      requestPoDelivery(fake.supabase, MANAGER, {
        tenantId: TENANT_A,
        purchaseOrderId: PO_ID,
        method: "email",
        idempotencyKey: "no-supplier-1",
      }),
    ).rejects.toThrow(/no supplier on file/i);
  });

  it("refuses a caller who is not a member of this restaurant tenant", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "purchasing_officer" }],
    });

    await expect(
      requestPoDelivery(fake.supabase, MANAGER, {
        tenantId: TENANT_A,
        purchaseOrderId: PO_ID,
        method: "email",
        idempotencyKey: "wrong-tenant-1",
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.getDeliveries()).toHaveLength(0);
  });

  it("refuses a role without purchasing.manage", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: WAITER, role: "waiter" }],
    });

    await expect(
      requestPoDelivery(fake.supabase, WAITER, {
        tenantId: TENANT_A,
        purchaseOrderId: PO_ID,
        method: "email",
        idempotencyKey: "wrong-role-1",
      }),
    ).rejects.toThrow(/purchasing\.manage/i);
  });

  it("never breaks the send when the audit/event writers fail", async () => {
    process.env["NOVA_EMAIL_WEBHOOK_URL"] = "https://relay.test/send";
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: true, provider: "email", reference: "msg-z" });

    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
      failEventInsert: true,
    });

    const result = await requestPoDelivery(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      method: "email",
      recipient: "purchasing@abcfoods.test",
      idempotencyKey: "event-fail-1",
    });

    expect(result.status).toBe("sent");
    expect(fake.getDeliveries()[0].status).toBe("sent");
  });
});

describe("listPoDeliveries — communication history", () => {
  it("lists prior attempts for a purchase order, newest concerns aside — just returns what's recorded", async () => {
    const fake = makeFakeSupabase({
      purchaseOrder: purchaseOrderRow(),
      supplier: supplierRow(),
      restaurantMembers: OWNER_MEMBER,
      existingDeliveries: [
        {
          id: "d1",
          tenant_id: TENANT_A,
          purchase_order_id: PO_ID,
          document_number: "PO-2026-000001",
          method: "email",
          recipient: "purchasing@abcfoods.test",
          status: "sent",
          attempt: 1,
          requested_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const rows = await listPoDeliveries(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      purchaseOrderId: PO_ID,
      limit: 20,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "email", status: "sent", attempt: 1 });
  });
});
