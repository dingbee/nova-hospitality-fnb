/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * End-to-end Request Staff lifecycle: the guest module (selfstaff.server.ts)
 * and the staff module (service-requests.server.ts) both read/write the
 * SAME restaurant_service_requests rows through a single shared fake
 * database — this is what actually proves "guest and staff remain
 * synchronized" (spec §18), rather than each module's own isolated tests
 * merely asserting compatible shapes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

import { guestStaffRequestStatus, requestStaff } from "../selforder/selfstaff.server";
import { acknowledgeServiceRequest, resolveServiceRequest } from "./service-requests.server";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const OWNER = "user-owner";
const NOBODY = "user-nobody";
const TABLE = "table-1";
const ORDER = "order-1";

/** One shared in-memory database, mutated by both the guest and staff modules — the real integration point. */
function sharedDb() {
  const tables: Record<string, any[]> = {
    restaurant_tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: "prop-1",
        location_id: null,
        active: true,
      },
    ],
    restaurant_tenants: [{ id: TENANT, name: "Demo", status: "active", settings: {} }],
    restaurant_orders: [
      { id: ORDER, order_number: "ORD-1", status: "open", table_id: TABLE, tenant_id: TENANT },
    ],
    restaurant_currencies: [],
    restaurant_members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    restaurant_service_requests: [],
  };

  return {
    rpc: async () => ({ data: false, error: null }),
    from(table: string) {
      let filtered = tables[table] ?? [];
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
        in(col: string, vals: unknown[]) {
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          const ascending = opts?.ascending !== false;
          filtered = [...filtered].sort((a, b) => {
            if (a[col] === b[col]) return 0;
            return (a[col] > b[col] ? 1 : -1) * (ascending ? 1 : -1);
          });
          return builder;
        },
        limit() {
          return builder;
        },
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return builder;
        },
        insert(row: Record<string, unknown>) {
          const inserted = { id: `req-${tables.restaurant_service_requests.length + 1}`, ...row };
          tables.restaurant_service_requests.push(inserted);
          return {
            select: () => ({ single: async () => ({ data: inserted, error: null }) }),
          };
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
    _rows: tables,
  };
}

describe("Request Staff lifecycle — guest/staff synchronization end to end", () => {
  it("full happy path: request -> staff sees it -> acknowledge -> guest sees it -> resolve -> guest enters cooldown -> guest cannot re-request during cooldown", async () => {
    const sb = sharedDb();

    // 1. GUEST REQUEST
    const requested = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(requested).toMatchObject({ ok: true, status: "requested" });

    // 2. STAFF RECEIVES IT (same row, read via the staff-only module)
    const requestId = sb._rows.restaurant_service_requests[0].id;
    const { listActiveServiceRequests } = await import("./service-requests.server");
    const active = await listActiveServiceRequests(sb as any, OWNER, TENANT);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(requestId);
    expect(active[0].status).toBe("requested");

    // 3. STAFF ACKNOWLEDGES
    await acknowledgeServiceRequest(sb as any, OWNER, { tenantId: TENANT, requestId });

    // 4. GUEST SEES THE ACKNOWLEDGEMENT (same underlying row, guest-side read)
    const afterAck = await guestStaffRequestStatus(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(afterAck).toMatchObject({ ok: true, status: "acknowledged" });

    // 5. GUEST CANNOT CREATE A DUPLICATE WHILE ACKNOWLEDGED
    const duringAck = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(duringAck).toEqual(afterAck);
    expect(sb._rows.restaurant_service_requests).toHaveLength(1);

    // 6. STAFF RESOLVES
    await resolveServiceRequest(sb as any, OWNER, { tenantId: TENANT, requestId });

    // 7. GUEST SEES RESOLUTION AS A COOLDOWN WINDOW
    const afterResolve = await guestStaffRequestStatus(sb as any, {
      tableId: TABLE,
      orderId: ORDER,
    });
    expect(afterResolve).toMatchObject({ ok: true, status: "cooldown" });
    expect((afterResolve as any).cooldownRemainingSeconds).toBeGreaterThan(0);

    // 8. RESOLVED REQUEST IS NO LONGER "ACTIVE" FOR STAFF
    const activeAfterResolve = await listActiveServiceRequests(sb as any, OWNER, TENANT);
    expect(activeAfterResolve).toHaveLength(0);

    // 9. GUEST CANNOT REQUEST AGAIN DURING COOLDOWN
    const duringCooldown = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(duringCooldown).toMatchObject({ ok: true, status: "cooldown" });
    expect(sb._rows.restaurant_service_requests).toHaveLength(1); // still no second row
  });

  it("§11/§12 — refresh and a second browser tab both re-derive the identical state from the server, with no client cache to disagree", async () => {
    const sb = sharedDb();
    await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    const requestId = sb._rows.restaurant_service_requests[0].id;
    await acknowledgeServiceRequest(sb as any, OWNER, { tenantId: TENANT, requestId });
    await resolveServiceRequest(sb as any, OWNER, { tenantId: TENANT, requestId });

    // Two independent reads ("refresh" and "a second tab") against the same
    // server state must agree exactly.
    const tabOne = await guestStaffRequestStatus(sb as any, { tableId: TABLE, orderId: ORDER });
    const tabTwo = await guestStaffRequestStatus(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(tabOne).toEqual(tabTwo);

    // A second concurrent "request" call from either tab during cooldown is
    // refused identically — neither tab can bypass it.
    const attemptFromTabOne = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    const attemptFromTabTwo = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    expect((attemptFromTabOne as any).status).toBe("cooldown");
    expect((attemptFromTabTwo as any).status).toBe("cooldown");
    expect(sb._rows.restaurant_service_requests).toHaveLength(1);
  });

  it("§13 — direct endpoint manipulation: extra/forged fields on the guest request payload are ignored, never trusted", async () => {
    const sb = sharedDb();
    // The contract only ever accepts tableId/orderId (see selfstaff.contracts.ts /
    // authorization-gate.test.ts's structural guard) — simulating a client
    // trying to also smuggle a status/timestamp/tenantId through the same call.
    const forged = {
      tableId: TABLE,
      orderId: ORDER,
      status: "acknowledged",
      tenantId: OTHER_TENANT,
      resolvedAt: "2020-01-01T00:00:00.000Z",
    } as any;
    const result = await requestStaff(sb as any, forged);
    expect(result).toMatchObject({ ok: true, status: "requested" });
    // The row actually written belongs to TENANT (re-derived server-side),
    // never OTHER_TENANT from the forged payload.
    expect(sb._rows.restaurant_service_requests[0].tenant_id).toBe(TENANT);
  });

  it("§14 — a staff member cannot resolve a request belonging to a different tenant by only changing the tenantId parameter", async () => {
    const sb = sharedDb();
    await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    const requestId = sb._rows.restaurant_service_requests[0].id;
    // OWNER only has a restaurant_members row for TENANT, not OTHER_TENANT —
    // assertCapability must refuse regardless of which tenantId is passed.
    await expect(
      resolveServiceRequest(sb as any, OWNER, { tenantId: OTHER_TENANT, requestId }),
    ).rejects.toThrow(/forbidden/i);
    // And an unauthorized user can never resolve within the correct tenant either.
    await expect(
      resolveServiceRequest(sb as any, NOBODY, { tenantId: TENANT, requestId }),
    ).rejects.toThrow(/forbidden/i);
  });
});
