/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * I4 — the first Act-stage executor.
 *
 * Exercises the REAL registered tenant scope checker (restaurant/intelligence/
 * provider.ts) and the REAL restaurant/core/access.server.ts capability gate
 * against a fake Supabase client, not a stub of the checks themselves —
 * exactly the same methodology decision.server.test.ts uses for I2/I3.
 */
import { describe, expect, it } from "vitest";
import { executeRestaurantAction } from "./actions.server";

// Registers the restaurant provider + its tenant scope checker as a side
// effect, exactly like the real app does via the admin/restaurant layout.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const MANAGER = "33333333-3333-3333-3333-333333333333";
const WAITER = "44444444-4444-4444-4444-444444444444";
const DECISION_ID = "55555555-5555-5555-5555-555555555555";
const INVENTORY_ITEM_ID = "66666666-6666-6666-6666-666666666666";
const SUPPLIER_ID = "77777777-7777-7777-7777-777777777777";

function findingFacts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hasSupplier: true,
    unreliableSupplier: false,
    estimatedCost: 45000,
    leadTimeDays: 3,
    inventoryItemId: INVENTORY_ITEM_ID,
    recommendedQuantity: 30,
    supplierId: SUPPLIER_ID,
    estimatedUnitCost: 1500,
    currency: "TZS",
    ...overrides,
  };
}

function decisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DECISION_ID,
    tenant_id: TENANT_A,
    module: "restaurant",
    decision_key: "restaurant.tenant.finding.purchasing",
    property_id: null,
    location_id: null,
    context: {
      finding: {
        subject: "UAT reorder ingredient",
        headline: "UAT reorder ingredient needs a replenishment order of about 30",
        facts: findingFacts(),
      },
    },
    ...overrides,
  };
}

function actionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "88888888-8888-8888-8888-888888888888",
    decision_id: DECISION_ID,
    module: "restaurant",
    action_type: "restaurant.purchase.suggest",
    status: "approved",
    result: null,
    ...overrides,
  };
}

/** Minimal thenable query builder — enough to cover executeRestaurantAction's call shapes. */
function makeFakeSupabase(opts: {
  action: Record<string, any> | null;
  decision: Record<string, any> | null;
  restaurantMembers: Array<{ tenant_id: string; user_id: string; role: string }>;
  existingRequestByCorrelation?: Record<string, any> | null;
  failRequestInsert?: boolean;
  failLineInsert?: boolean;
}) {
  const calls: Array<{
    table: string;
    op: "select" | "update" | "insert";
    payload?: any;
    filters: Record<string, unknown>;
  }> = [];
  let action = opts.action ? { ...opts.action } : null;
  let requestCreated: Record<string, any> | null = opts.existingRequestByCorrelation ?? null;
  let requestInsertCount = 0;
  let lineInsertCount = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
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
      single: () => resolve(true),
      maybeSingle: () => resolve(false),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(single: boolean) {
      calls.push({ table, op, payload, filters: { ...filters } });

      if (op === "select") {
        if (table === "intelligence_actions") {
          return { data: action, error: action ? null : { message: "not found" } };
        }
        if (table === "intelligence_decisions") {
          return { data: opts.decision, error: opts.decision ? null : { message: "not found" } };
        }
        if (table === "restaurant_members") {
          const rows = opts.restaurantMembers.filter(
            (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
          );
          return { data: rows, error: null };
        }
        if (table === "restaurant_purchase_requests") {
          const match =
            requestCreated &&
            requestCreated.tenant_id === filters.tenant_id &&
            requestCreated.correlation_id === filters.correlation_id;
          return { data: match ? requestCreated : null, error: null };
        }
        return { data: single ? null : [], error: null };
      }

      if (op === "update") {
        if (table === "intelligence_actions" && action) {
          action = { ...action, ...payload };
        }
        return { data: null, error: null };
      }

      // insert
      if (table === "restaurant_purchase_requests") {
        requestInsertCount += 1;
        if (opts.failRequestInsert) return { data: null, error: { message: "insert failed" } };
        requestCreated = {
          id: "created-request-id",
          tenant_id: payload.tenant_id,
          correlation_id: payload.correlation_id,
          status: payload.status,
        };
        return { data: { id: requestCreated.id }, error: null };
      }
      if (table === "restaurant_purchase_request_items") {
        lineInsertCount += 1;
        if (opts.failLineInsert) return { data: null, error: { message: "line insert failed" } };
        return { data: { id: "generated" }, error: null };
      }
      if (table === "restaurant_procurement_audit") {
        return { data: { id: "generated" }, error: null };
      }
      return { data: { id: "generated" }, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string, _args: Record<string, unknown>) => {
        if (fn === "has_any_role") return { data: false, error: null }; // never a platform admin
        if (fn === "restaurant_next_document_number")
          return { data: "PR-2026-000001", error: null };
        return { data: null, error: null };
      },
    },
    calls,
    getAction: () => action,
    getRequestInsertCount: () => requestInsertCount,
    getLineInsertCount: () => lineInsertCount,
  };
}

const OWNER_MEMBER = [{ tenant_id: TENANT_A, user_id: MANAGER, role: "purchasing_officer" }];

describe("executeRestaurantAction — first Act-stage executor", () => {
  it("creates a draft procurement request and completes the action", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toMatchObject({
      status: "completed",
      executionResult: "procurement_request_created",
      procurementRequestId: "created-request-id",
      procurementRequestStatus: "draft",
    });
    expect(fake.getRequestInsertCount()).toBe(1);
    expect(fake.getLineInsertCount()).toBe(1);

    const requestInsert = fake.calls.find(
      (c) => c.table === "restaurant_purchase_requests" && c.op === "insert",
    );
    expect(requestInsert!.payload.status).toBe("draft");
    expect(requestInsert!.payload.tenant_id).toBe(TENANT_A);
    expect(requestInsert!.payload.correlation_id).toBe(actionRow().id);
    expect(requestInsert!.payload.metadata).toMatchObject({
      source: "intelligence",
      decision_id: DECISION_ID,
      action_id: actionRow().id,
    });

    const lineInsert = fake.calls.find(
      (c) => c.table === "restaurant_purchase_request_items" && c.op === "insert",
    );
    expect(lineInsert!.payload).toMatchObject({
      inventory_item_id: INVENTORY_ITEM_ID,
      preferred_supplier_id: SUPPLIER_ID,
      quantity: 30,
    });

    expect(fake.getAction()?.status).toBe("completed");
    expect(fake.getAction()?.result).toMatchObject({
      procurement_request_id: "created-request-id",
    });
  });

  it("does not re-execute a completed action — returns the prior result", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        status: "completed",
        result: { procurement_request_id: "already-there", procurement_request_status: "draft" },
      }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toEqual({
      actionId: actionRow().id,
      status: "completed",
      executionResult: "procurement_request_created",
      procurementRequestId: "already-there",
      procurementRequestStatus: "draft",
      alreadyExecuted: true,
    });
    expect(fake.getRequestInsertCount()).toBe(0);
    expect(fake.getLineInsertCount()).toBe(0);
  });

  it("recovers an existing request by correlation_id after a partial failure, without duplicating it", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ status: "executing" }), // a previous attempt crashed after creating the request
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequestByCorrelation: {
        id: "recovered-request-id",
        tenant_id: TENANT_A,
        correlation_id: actionRow().id,
        status: "draft",
      },
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toMatchObject({
      status: "completed",
      procurementRequestId: "recovered-request-id",
      procurementRequestStatus: "draft",
    });
    expect(fake.getRequestInsertCount()).toBe(0); // never a second draft
    expect(fake.getLineInsertCount()).toBe(0);
    expect(fake.getAction()?.status).toBe("completed");
  });

  it("refuses a caller who is not a restaurant_members of the decision's tenant", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "purchasing_officer" }], // wrong tenant
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);

    expect(fake.getRequestInsertCount()).toBe(0);
    expect(fake.getAction()?.status).toBe("approved"); // untouched — rejected before any mutation
  });

  it("fails the action when the caller lacks purchase.request capability", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: WAITER, role: "waiter" }], // right tenant, wrong role
    });

    const result = await executeRestaurantAction(fake.supabase, WAITER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/purchase\.request.*requires/i);
    expect(fake.getRequestInsertCount()).toBe(0);
    expect(fake.getAction()?.status).toBe("failed");
  });

  it("fails cleanly when the decision carries no supplier for the item", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow({
        context: {
          finding: {
            subject: "x",
            headline: "x",
            facts: findingFacts({ supplierId: null, hasSupplier: false }),
          },
        },
      }),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no supplier product on file/i);
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("fails cleanly on a malformed action whose decision has no structured purchasing data", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow({
        context: { finding: { subject: "x", headline: "x", facts: { hasSupplier: true } } },
      }),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no structured purchasing data/i);
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("captures a procurement request insert failure as a failed action, not a fabricated success", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      failRequestInsert: true,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("insert failed");
    expect(fake.getAction()?.status).toBe("failed");
    expect(fake.getLineInsertCount()).toBe(0); // no orphan line for a request that doesn't exist
  });

  it("captures a line-item insert failure as a failed action", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      failLineInsert: true,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("line insert failed");
    expect(fake.getAction()?.status).toBe("failed");
  });

  it("refuses to execute an action that was never approved", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ status: "proposed" }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
    ).rejects.toThrow(/only an approved action can be executed/i);
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("refuses an action type this executor does not know how to run", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ action_type: "restaurant.menu.reprice_review" }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
    ).rejects.toThrow(/no executor registered for action type/i);
  });

  it("refuses an action from a module this executor does not own", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ module: "revenue" }),
      decision: decisionRow({ module: "revenue" }),
      restaurantMembers: OWNER_MEMBER,
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
    ).rejects.toThrow(/no executor registered for module/i);
  });
});
