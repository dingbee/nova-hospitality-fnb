/**
 * P08 — outbound webhook engine: fan-out scoping and delivery-claim
 * concurrency. There was previously no test coverage at all for
 * enqueueWebhookEvent/deliverWebhookDelivery — these tests exist to prove
 * the tenant/property/event-type fan-out filtering (ME-12 Phase 10A) and
 * the atomic delivery claim that prevents two overlapping dispatch-route
 * invocations from double-delivering the same event (ME-12 Phase 8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import { encryptSecret } from "./crypto.server";
import { deliverWebhookDelivery, enqueueWebhookEvent } from "./webhooks.server";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env.NOVA_API_PLATFORM_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function endpointRow(overrides: Record<string, unknown> = {}) {
  const enc = encryptSecret("whsec-test-secret");
  return {
    id: "endpoint-1",
    tenant_id: "tenant-a",
    property_id: null,
    url: "https://partner.example.com/hooks/nova",
    status: "active",
    events: ["order.created"],
    secret_ciphertext: enc.ciphertext,
    secret_iv: enc.iv,
    secret_tag: enc.tag,
    secret_prefix: "whsec-t",
    ...overrides,
  };
}

describe("enqueueWebhookEvent — fan-out scoping", () => {
  it("delivers only to endpoints in the SAME tenant", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [
        endpointRow({ id: "e-a", tenant_id: "tenant-a" }),
        endpointRow({ id: "e-b", tenant_id: "tenant-b" }),
      ],
      api_webhook_deliveries: [],
    });
    const ids = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: null,
      eventType: "order.created",
      payload: {},
    });
    expect(ids).toHaveLength(1);
    const rows = (await sb.from("api_webhook_deliveries").select("*")).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].webhook_endpoint_id).toBe("e-a");
  });

  it("a tenant-wide endpoint (property_id null) receives events for every property", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [endpointRow({ id: "e-wide", property_id: null })],
      api_webhook_deliveries: [],
    });
    const idsA = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: "property-x",
      eventType: "order.created",
      payload: {},
    });
    const idsB = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: "property-y",
      eventType: "order.created",
      payload: {},
    });
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
  });

  it("a property-scoped endpoint receives ONLY its own property's events — not another property in the same tenant", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [endpointRow({ id: "e-p1", property_id: "property-1" })],
      api_webhook_deliveries: [],
    });
    const forOwnProperty = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: "property-1",
      eventType: "order.created",
      payload: {},
    });
    const forOtherProperty = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: "property-2",
      eventType: "order.created",
      payload: {},
    });
    expect(forOwnProperty).toHaveLength(1);
    expect(forOtherProperty).toHaveLength(0);
  });

  it("only fans out to endpoints subscribed to the exact event type", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [
        endpointRow({ id: "e-created", events: ["order.created"] }),
        endpointRow({ id: "e-status", events: ["order.status_changed"] }),
        endpointRow({ id: "e-both", events: ["order.created", "order.status_changed"] }),
      ],
      api_webhook_deliveries: [],
    });
    const ids = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: null,
      eventType: "order.status_changed",
      payload: {},
    });
    expect(ids).toHaveLength(2);
    const rows = (await sb.from("api_webhook_deliveries").select("*")).data;
    const endpointIds = rows
      .map((r: { webhook_endpoint_id: string }) => r.webhook_endpoint_id)
      .sort();
    expect(endpointIds).toEqual(["e-both", "e-status"]);
  });

  it("never fans out to a disabled endpoint", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [endpointRow({ id: "e-disabled", status: "disabled" })],
      api_webhook_deliveries: [],
    });
    const ids = await enqueueWebhookEvent(sb, {
      tenantId: "tenant-a",
      propertyId: null,
      eventType: "order.created",
      payload: {},
    });
    expect(ids).toHaveLength(0);
  });
});

describe("deliverWebhookDelivery — atomic claim (concurrency)", () => {
  function seeded() {
    return createFakeSupabase({
      api_webhook_endpoints: [endpointRow()],
      api_webhook_deliveries: [
        {
          id: "delivery-1",
          tenant_id: "tenant-a",
          webhook_endpoint_id: "endpoint-1",
          event_type: "order.created",
          event_id: "event-1",
          payload: { orderId: "order-1" },
          status: "pending",
          attempt_count: 0,
          max_attempts: 8,
          next_attempt_at: new Date().toISOString(),
        },
      ],
    });
  }

  it("delivers a pending row and marks it delivered on a 200 response", async () => {
    const sb = seeded();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    await deliverWebhookDelivery(sb, "delivery-1");
    const row = await sb
      .from("api_webhook_deliveries")
      .select("*")
      .eq("id", "delivery-1")
      .maybeSingle();
    expect(row.data.status).toBe("delivered");
    expect(row.data.attempt_count).toBe(1);
  });

  it("a delivery already in_flight is never claimed twice — the second call is a no-op", async () => {
    const sb = seeded();
    // Simulate: another worker already claimed this row a moment ago.
    await sb.from("api_webhook_deliveries").update({ status: "in_flight" }).eq("id", "delivery-1");
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhookDelivery(sb, "delivery-1");

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await sb
      .from("api_webhook_deliveries")
      .select("*")
      .eq("id", "delivery-1")
      .maybeSingle();
    // Left exactly as the "other worker" set it — this call touched nothing.
    expect(row.data.status).toBe("in_flight");
  });

  it("two overlapping deliveries of the SAME row result in exactly one outbound HTTP call — proves the claim, not a sequential test", async () => {
    const sb = seeded();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Both "workers" attempt the claim before either has delivered — the
    // fake's synchronous update-then-filter still proves the SQL-level
    // guarantee (UPDATE ... WHERE status IN (...) is atomic per row in
    // Postgres; this asserts the application code relies on exactly that
    // conditional update rather than a read-then-act check).
    await Promise.all([
      deliverWebhookDelivery(sb, "delivery-1"),
      deliverWebhookDelivery(sb, "delivery-1"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a delivered row is never re-claimed or re-delivered", async () => {
    const sb = seeded();
    await sb.from("api_webhook_deliveries").update({ status: "delivered" }).eq("id", "delivery-1");
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhookDelivery(sb, "delivery-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the row dead_letter if the endpoint has been disabled since enqueue, without attempting delivery", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [endpointRow({ status: "disabled" })],
      api_webhook_deliveries: [
        {
          id: "delivery-1",
          tenant_id: "tenant-a",
          webhook_endpoint_id: "endpoint-1",
          event_type: "order.created",
          event_id: "event-1",
          payload: {},
          status: "pending",
          attempt_count: 0,
          max_attempts: 8,
          next_attempt_at: new Date().toISOString(),
        },
      ],
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhookDelivery(sb, "delivery-1");

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await sb
      .from("api_webhook_deliveries")
      .select("*")
      .eq("id", "delivery-1")
      .maybeSingle();
    expect(row.data.status).toBe("dead_letter");
  });

  it("retries with backoff on a non-2xx response, and dead-letters once max_attempts is reached", async () => {
    const sb = createFakeSupabase({
      api_webhook_endpoints: [endpointRow()],
      api_webhook_deliveries: [
        {
          id: "delivery-1",
          tenant_id: "tenant-a",
          webhook_endpoint_id: "endpoint-1",
          event_type: "order.created",
          event_id: "event-1",
          payload: {},
          status: "failed",
          attempt_count: 7,
          max_attempts: 8,
          next_attempt_at: new Date().toISOString(),
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await deliverWebhookDelivery(sb, "delivery-1");

    const row = await sb
      .from("api_webhook_deliveries")
      .select("*")
      .eq("id", "delivery-1")
      .maybeSingle();
    expect(row.data.attempt_count).toBe(8);
    expect(row.data.status).toBe("dead_letter");
  });
});
