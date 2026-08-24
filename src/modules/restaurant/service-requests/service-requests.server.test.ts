/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it, vi } from "vitest";
import { acknowledgeServiceRequest, listActiveServiceRequests } from "./service-requests.server";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));
import { emitRestaurantEvent } from "../events/emit.server";

const TENANT = "tenant-1";
const OWNER = "user-owner";
const NOBODY = "user-nobody";
const REQUEST = "request-1";
const TABLE = "table-1";
const ORDER = "order-1";

/**
 * In-memory Supabase stand-in covering both the RBAC guard chain
 * (rpc("has_any_role"), restaurant_members) and the plain
 * restaurant_service_requests reads/writes this module performs.
 */
function fakeDb(seed: { members?: any[]; requests?: any[] }) {
  const rows: Record<string, any[]> = {
    restaurant_members: seed.members ?? [],
    restaurant_service_requests: seed.requests ?? [],
  };

  return {
    rpc: async () => ({ data: false, error: null }),
    from(table: string) {
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
        order() {
          return builder;
        },
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return builder;
        },
        maybeSingle: async () => {
          applyPatch();
          return { data: filtered[0] ?? null };
        },
        single: async () => {
          applyPatch();
          return {
            data: filtered[0] ?? null,
            error: filtered[0] ? null : { message: "not found" },
          };
        },
        then: (resolve: (v: { data: any[]; error: null }) => unknown) => {
          applyPatch();
          return resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

function seedFor(requests: any[] = []) {
  return fakeDb({
    members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    requests: requests.map((r) => ({ tenant_id: TENANT, ...r })),
  });
}

describe("listActiveServiceRequests", () => {
  it("a tenant member sees only the active (requested) alerts, oldest first", async () => {
    const sb = seedFor([
      {
        id: "r1",
        table_id: TABLE,
        order_id: ORDER,
        request_type: "assistance",
        status: "requested",
        requested_at: "t1",
        acknowledged_at: null,
      },
      {
        id: "r2",
        table_id: "table-2",
        order_id: "order-2",
        request_type: "assistance",
        status: "acknowledged",
        requested_at: "t0",
        acknowledged_at: "t2",
      },
    ]);
    const result = await listActiveServiceRequests(sb as any, OWNER, TENANT);
    expect(result).toEqual([
      {
        id: "r1",
        tableId: TABLE,
        orderId: ORDER,
        requestType: "assistance",
        status: "requested",
        requestedAt: "t1",
        acknowledgedAt: null,
      },
    ]);
  });

  it("someone with no membership in this tenant is refused", async () => {
    const sb = seedFor([]);
    await expect(listActiveServiceRequests(sb as any, NOBODY, TENANT)).rejects.toThrow(
      /forbidden/i,
    );
  });
});

describe("acknowledgeServiceRequest", () => {
  it("a qualifying staff member (owner) can acknowledge a request", async () => {
    vi.mocked(emitRestaurantEvent).mockClear();
    const sb = seedFor([
      {
        id: REQUEST,
        table_id: TABLE,
        order_id: ORDER,
        request_type: "assistance",
        status: "requested",
        requested_at: "t1",
        acknowledged_at: null,
        property_id: null,
        location_id: null,
      },
    ]);
    const result = await acknowledgeServiceRequest(sb as any, OWNER, {
      tenantId: TENANT,
      requestId: REQUEST,
    });
    expect(result.status).toBe("acknowledged");
    expect(result.acknowledgedAt).toBeTruthy();
    expect(emitRestaurantEvent).toHaveBeenCalledTimes(1);
  });

  it("a user without sales.manage-qualifying role is refused", async () => {
    const sb = fakeDb({
      members: [{ tenant_id: TENANT, user_id: NOBODY, role: "viewer" }],
      requests: [
        {
          tenant_id: TENANT,
          id: REQUEST,
          table_id: TABLE,
          order_id: ORDER,
          request_type: "assistance",
          status: "requested",
          requested_at: "t1",
          acknowledged_at: null,
        },
      ],
    });
    await expect(
      acknowledgeServiceRequest(sb as any, NOBODY, { tenantId: TENANT, requestId: REQUEST }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("a nonexistent request is safely rejected", async () => {
    const sb = seedFor([]);
    await expect(
      acknowledgeServiceRequest(sb as any, OWNER, {
        tenantId: TENANT,
        requestId: "no-such-request",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("acknowledging an already-acknowledged request is idempotent — no second write, no second event", async () => {
    vi.mocked(emitRestaurantEvent).mockClear();
    const sb = seedFor([
      {
        id: REQUEST,
        table_id: TABLE,
        order_id: ORDER,
        request_type: "assistance",
        status: "acknowledged",
        requested_at: "t1",
        acknowledged_at: "t2",
        property_id: null,
        location_id: null,
      },
    ]);
    const result = await acknowledgeServiceRequest(sb as any, OWNER, {
      tenantId: TENANT,
      requestId: REQUEST,
    });
    expect(result).toEqual({
      id: REQUEST,
      tableId: TABLE,
      orderId: ORDER,
      requestType: "assistance",
      status: "acknowledged",
      requestedAt: "t1",
      acknowledgedAt: "t2",
    });
    expect(emitRestaurantEvent).not.toHaveBeenCalled();
  });
});
