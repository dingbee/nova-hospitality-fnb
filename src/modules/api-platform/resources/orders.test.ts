/**
 * P08 — /api/v1/orders resource wrappers. There was previously no test
 * coverage at all for this file (ME-12 finding). These tests pin down two
 * classes of defect found and fixed during ME-12 certification:
 *
 *  - apiGetOrder/apiTransitionOrderStatus previously let a plain Error from
 *    the underlying canonical order module (getOrder/transitionOrder)
 *    escape uncaught, which the router's catch-all maps to a generic 500 —
 *    correct as a fail-safe for a genuine bug, wrong for the everyday,
 *    expected cases of "order not found" and "order already closed",
 *    which a partner integration hits routinely and needs as 404/409, not
 *    "our server is broken".
 *  - the property-scope check (Phase 4 object-level authorization) is
 *    exercised end to end here, not just at the scope.server.ts primitive
 *    level.
 *
 * Domain modules are mocked — this file proves the api-platform WRAPPER's
 * own behavior (auth/scope/error-mapping), not the canonical order logic
 * those modules already own and are certified elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import { ApiError } from "../errors";
import type { ResolvedCredential } from "../credentials.server";

const mocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  listOrders: vi.fn(),
  transitionOrder: vi.fn(),
  openPosOrder: vi.fn(),
  resolveOrderScope: vi.fn(),
  enqueueWebhookEvent: vi.fn(),
}));

vi.mock("@/modules/restaurant/sales/sales.server", () => ({
  getOrder: mocks.getOrder,
  listOrders: mocks.listOrders,
  transitionOrder: mocks.transitionOrder,
}));
vi.mock("@/modules/restaurant/sales/pos.server", () => ({
  openPosOrder: mocks.openPosOrder,
}));
vi.mock("@/modules/restaurant/sales/orderScope.server", () => ({
  resolveOrderScope: mocks.resolveOrderScope,
}));
vi.mock("../webhooks.server", () => ({
  enqueueWebhookEvent: mocks.enqueueWebhookEvent,
}));

const { apiGetOrder, apiTransitionOrderStatus } = await import("./orders");

function credential(overrides: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    id: "cred-1",
    tenantId: "tenant-a",
    propertyId: null,
    serviceUserId: "svc-1",
    scopes: ["orders:read", "orders:write"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apiGetOrder — not-found and property-scope classification", () => {
  it("a nonexistent order id is a 404 not_found, never a generic 500", async () => {
    const sb = createFakeSupabase({ restaurant_orders: [] });
    await expect(apiGetOrder(sb, credential(), "missing-order")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it("a cross-tenant order id (belongs to another tenant) is also a 404, not a leak of its existence", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [{ id: "order-1", tenant_id: "tenant-B", property_id: null }],
    });
    await expect(
      apiGetOrder(sb, credential({ tenantId: "tenant-a" }), "order-1"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a property-scoped credential cannot read an order from a DIFFERENT property in the same tenant", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [{ id: "order-1", tenant_id: "tenant-a", property_id: "property-B" }],
    });
    await expect(
      apiGetOrder(sb, credential({ propertyId: "property-A" }), "order-1"),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it("returns the order when it exists, belongs to the tenant, and the credential covers its property", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [{ id: "order-1", tenant_id: "tenant-a", property_id: "property-A" }],
    });
    mocks.getOrder.mockResolvedValue({
      order: { id: "order-1" },
      items: [],
      payments: [],
      tickets: [],
    });
    const result = await apiGetOrder(sb, credential({ propertyId: "property-A" }), "order-1");
    expect(result.order.id).toBe("order-1");
  });

  it("a tenant-wide credential (propertyId null) can read any property's order", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [{ id: "order-1", tenant_id: "tenant-a", property_id: "property-B" }],
    });
    mocks.getOrder.mockResolvedValue({
      order: { id: "order-1" },
      items: [],
      payments: [],
      tickets: [],
    });
    await expect(
      apiGetOrder(sb, credential({ propertyId: null }), "order-1"),
    ).resolves.toBeDefined();
  });

  it("enforces orders:read scope before touching the database", async () => {
    const sb = createFakeSupabase({ restaurant_orders: [] });
    await expect(
      apiGetOrder(sb, credential({ scopes: ["orders:write"] }), "order-1"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("apiTransitionOrderStatus — terminal-state conflict classification", () => {
  it("transitioning an already-closed order is a 409 conflict, never a generic 500", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [
        { id: "order-1", tenant_id: "tenant-a", property_id: null, status: "closed" },
      ],
    });
    await expect(
      apiTransitionOrderStatus(sb, credential(), "order-1", { status: "voided" }),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(mocks.transitionOrder).not.toHaveBeenCalled();
  });

  it("a same-status transition on a terminal order is a harmless no-op, not a conflict (matches transitionOrder's own semantics)", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [
        { id: "order-1", tenant_id: "tenant-a", property_id: null, status: "closed" },
      ],
    });
    mocks.transitionOrder.mockResolvedValue({ id: "order-1", status: "closed" });
    await expect(
      apiTransitionOrderStatus(sb, credential(), "order-1", { status: "closed" }),
    ).resolves.toBeDefined();
    expect(mocks.transitionOrder).toHaveBeenCalled();
  });

  it("a nonexistent order id is 404, not 500", async () => {
    const sb = createFakeSupabase({ restaurant_orders: [] });
    await expect(
      apiTransitionOrderStatus(sb, credential(), "missing", { status: "served" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a property-scoped credential cannot transition an order from a DIFFERENT property", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [
        { id: "order-1", tenant_id: "tenant-a", property_id: "property-B", status: "open" },
      ],
    });
    await expect(
      apiTransitionOrderStatus(sb, credential({ propertyId: "property-A" }), "order-1", {
        status: "served",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.transitionOrder).not.toHaveBeenCalled();
  });

  it("a legitimate in-flight transition succeeds and fans out the order.status_changed webhook", async () => {
    const sb = createFakeSupabase({
      restaurant_orders: [
        { id: "order-1", tenant_id: "tenant-a", property_id: null, status: "open" },
      ],
    });
    mocks.transitionOrder.mockResolvedValue({ id: "order-1", status: "served" });
    await apiTransitionOrderStatus(sb, credential(), "order-1", { status: "served" });
    expect(mocks.enqueueWebhookEvent).toHaveBeenCalledWith(
      sb,
      expect.objectContaining({ eventType: "order.status_changed" }),
    );
  });

  it("enforces orders:write scope before touching the database", async () => {
    const sb = createFakeSupabase({ restaurant_orders: [] });
    await expect(
      apiTransitionOrderStatus(sb, credential({ scopes: ["orders:read"] }), "order-1", {
        status: "served",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
