/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * I4 / P10 — the Act-stage executor and its Verify counterpart.
 *
 * Exercises the REAL registered tenant scope checker (restaurant/intelligence/
 * provider.ts) and the REAL restaurant/core/access.server.ts capability gate
 * against a fake Supabase client, not a stub of the checks themselves —
 * exactly the same methodology decision.server.test.ts uses for I2/I3.
 */
import { describe, expect, it } from "vitest";
import { executeRestaurantAction, verifyRestaurantAction } from "./actions.server";

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
const OTHER_ITEM_ID = "99999999-9999-9999-9999-999999999999";

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
    queued_at: null,
    executing_at: null,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    verified_at: null,
    verification_result: null,
    ...overrides,
  };
}

function matchesFilters(row: Record<string, any>, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([k, v]) => row[k] === v);
}

/**
 * Minimal in-memory query builder — enough to cover executeRestaurantAction
 * and verifyRestaurantAction's call shapes, including status-guarded
 * updates (so the concurrency guard is genuinely exercised, not just
 * blindly applied) and array-shaped selects for the duplicate-request and
 * line-item checks Verify performs.
 */
function makeFakeSupabase(opts: {
  action: Record<string, any> | null;
  decision: Record<string, any> | null;
  restaurantMembers: Array<{ tenant_id: string; user_id: string; role: string }>;
  existingRequestByCorrelation?: Record<string, any> | null;
  existingRequests?: Array<Record<string, any>>;
  existingItems?: Array<Record<string, any>>;
  failRequestInsert?: boolean;
  failLineInsert?: boolean;
  failEventInsert?: boolean;
  // I6
  menuItem?: Record<string, any> | null;
  existingPriceReviews?: Array<Record<string, any>>;
  failPriceReviewInsert?: boolean;
}) {
  const calls: Array<{
    table: string;
    op: "select" | "update" | "insert";
    payload?: any;
    filters: Record<string, unknown>;
  }> = [];
  let action = opts.action ? { ...opts.action } : null;
  const requests: Record<string, any>[] = [
    ...(opts.existingRequestByCorrelation ? [{ ...opts.existingRequestByCorrelation }] : []),
    ...(opts.existingRequests ?? []).map((r) => ({ ...r })),
  ];
  const items: Record<string, any>[] = (opts.existingItems ?? []).map((i) => ({ ...i }));
  const priceReviews: Record<string, any>[] = (opts.existingPriceReviews ?? []).map((r) => ({
    ...r,
  }));
  const events: Record<string, any>[] = [];
  let requestInsertCount = 0;
  let lineInsertCount = 0;
  let priceReviewInsertCount = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;
    let mode: "single" | "maybeSingle" | "many" = "many";

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      is: (col: string, val: unknown) => {
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
      calls.push({ table, op, payload, filters: { ...filters } });

      if (op === "select") {
        if (table === "intelligence_actions") {
          const match = action && matchesFilters(action, filters) ? action : null;
          if (mode === "single")
            return { data: match, error: match ? null : { message: "not found" } };
          return { data: match, error: null };
        }
        if (table === "intelligence_decisions") {
          const match =
            opts.decision && matchesFilters(opts.decision, filters) ? opts.decision : null;
          if (mode === "single")
            return { data: match, error: match ? null : { message: "not found" } };
          return { data: match, error: null };
        }
        if (table === "restaurant_members") {
          const rows = opts.restaurantMembers.filter((m) => matchesFilters(m, filters));
          return { data: rows, error: null };
        }
        if (table === "restaurant_purchase_requests") {
          const matches = requests.filter((r) => matchesFilters(r, filters));
          if (mode === "single")
            return {
              data: matches[0] ?? null,
              error: matches[0] ? null : { message: "not found" },
            };
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        if (table === "restaurant_purchase_request_items") {
          const matches = items.filter((r) => matchesFilters(r, filters));
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        if (table === "restaurant_menu_items") {
          const match =
            opts.menuItem && matchesFilters(opts.menuItem, filters) ? opts.menuItem : null;
          return { data: match, error: null };
        }
        if (table === "restaurant_prices") {
          const matches = priceReviews.filter((r) => matchesFilters(r, filters));
          if (mode === "single")
            return {
              data: matches[0] ?? null,
              error: matches[0] ? null : { message: "not found" },
            };
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        if (table === "intelligence_events") {
          const matches = events.filter((r) => matchesFilters(r, filters));
          return { data: matches[0] ?? null, error: null };
        }
        return { data: mode === "many" ? [] : null, error: null };
      }

      if (op === "update") {
        if (table === "intelligence_actions") {
          if (!action || !matchesFilters(action, filters)) return { data: null, error: null };
          action = { ...action, ...payload };
          return { data: mode === "many" ? [action] : action, error: null };
        }
        return { data: null, error: null };
      }

      // insert
      if (table === "restaurant_purchase_requests") {
        requestInsertCount += 1;
        if (opts.failRequestInsert) return { data: null, error: { message: "insert failed" } };
        if (
          requests.some(
            (r) => r.tenant_id === payload.tenant_id && r.correlation_id === payload.correlation_id,
          )
        ) {
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          };
        }
        const id =
          requestInsertCount === 1
            ? "created-request-id"
            : `created-request-id-${requestInsertCount}`;
        const row = {
          id,
          tenant_id: payload.tenant_id,
          correlation_id: payload.correlation_id,
          status: payload.status,
          document_number: payload.document_number,
        };
        requests.push(row);
        return { data: { id }, error: null };
      }
      if (table === "restaurant_purchase_request_items") {
        lineInsertCount += 1;
        if (opts.failLineInsert) return { data: null, error: { message: "line insert failed" } };
        const id = `item-${lineInsertCount}`;
        items.push({ id, ...payload });
        return { data: { id }, error: null };
      }
      if (table === "restaurant_procurement_audit") {
        return { data: { id: "generated" }, error: null };
      }
      if (table === "restaurant_prices") {
        priceReviewInsertCount += 1;
        if (opts.failPriceReviewInsert) return { data: null, error: { message: "insert failed" } };
        if (
          priceReviews.some(
            (r) => r.tenant_id === payload.tenant_id && r.correlation_id === payload.correlation_id,
          )
        ) {
          return {
            data: null,
            error: { message: "duplicate key value violates unique constraint", code: "23505" },
          };
        }
        const id =
          priceReviewInsertCount === 1
            ? "created-review-id"
            : `created-review-id-${priceReviewInsertCount}`;
        const row = { id, ...payload };
        priceReviews.push(row);
        return { data: { id, status: payload.status }, error: null };
      }
      if (table === "restaurant_pricing_audit") {
        return { data: { id: "generated" }, error: null };
      }
      if (table === "intelligence_events") {
        if (opts.failEventInsert) return { data: null, error: { message: "event insert failed" } };
        const id = `event-${events.length + 1}`;
        events.push({ id, ...payload });
        return { data: { id }, error: null };
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
    getRequests: () => requests,
    getItems: () => items,
    getEvents: () => events,
    getRequestInsertCount: () => requestInsertCount,
    getLineInsertCount: () => lineInsertCount,
    getPriceReviews: () => priceReviews,
    getPriceReviewInsertCount: () => priceReviewInsertCount,
  };
}

const OWNER_MEMBER = [{ tenant_id: TENANT_A, user_id: MANAGER, role: "purchasing_officer" }];

describe("executeRestaurantAction — Act", () => {
  it("creates a draft procurement request and drives approved -> queued -> executing -> executed", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toMatchObject({
      status: "executed",
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

    // Genuinely stateful: real, distinct timestamps at every meaningful
    // transition, not just a single insert-then-say-executed.
    const finalAction = fake.getAction();
    expect(finalAction?.status).toBe("executed");
    expect(finalAction?.queued_at).toBeTruthy();
    expect(finalAction?.executing_at).toBeTruthy();
    expect(finalAction?.completed_at).toBeTruthy();
    expect(finalAction?.result).toMatchObject({ procurement_request_id: "created-request-id" });

    // intelligence.action.queued / executing / executed emitted, in order,
    // via the existing tenant-scoped, idempotent intelligence_events writer.
    const eventTypes = fake.getEvents().map((e) => e.event_type);
    expect(eventTypes).toEqual([
      "intelligence.action.queued",
      "intelligence.action.executing",
      "intelligence.action.executed",
    ]);
    for (const e of fake.getEvents()) {
      expect(e.module).toBe("restaurant");
      expect(e.tenant_id).toBe(TENANT_A);
      expect(e.entity_type).toBe("intelligence_action");
      expect(e.entity_id).toBe(actionRow().id);
    }
  });

  it("does not re-execute an already-executed action — returns the prior result (idempotent re-run)", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        status: "executed",
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
      status: "executed",
      executionResult: "procurement_request_created",
      procurementRequestId: "already-there",
      procurementRequestStatus: "draft",
      alreadyExecuted: true,
    });
    expect(fake.getRequestInsertCount()).toBe(0);
    expect(fake.getLineInsertCount()).toBe(0);
    expect(fake.getEvents()).toHaveLength(0); // no re-transition, no new event
  });

  it("recognizes a legacy 'completed' row (pre-P10 vocabulary) as already executed", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        status: "completed",
        result: { procurement_request_id: "legacy-request", procurement_request_status: "draft" },
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
      procurementRequestId: "legacy-request",
      procurementRequestStatus: "draft",
      alreadyExecuted: true,
    });
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("recovers an existing request by correlation_id after a partial failure, without duplicating it", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ status: "executing", executing_at: "2026-01-01T00:00:00.000Z" }), // a previous attempt crashed after creating the request
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
      status: "executed",
      procurementRequestId: "recovered-request-id",
      procurementRequestStatus: "draft",
    });
    expect(fake.getRequestInsertCount()).toBe(0); // never a second draft
    expect(fake.getLineInsertCount()).toBe(0);
    expect(fake.getAction()?.status).toBe("executed");
  });

  it("protects against two concurrent executions of the same action — exactly one request, both callers converge", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const [a, b] = await Promise.all([
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: actionRow().id }),
    ]);

    // Two insert attempts can be made (the loser's collides with the
    // winner's tenant_id+correlation_id unique constraint), but exactly one
    // request row — and one line item — actually exists afterward, and the
    // loser recovers the winner's row rather than erroring or duplicating.
    expect(fake.getRequests()).toHaveLength(1);
    expect(fake.getLineInsertCount()).toBe(1);
    expect(a.status).toBe("executed");
    expect(b.status).toBe("executed");
    expect(a.procurementRequestId).toBe(b.procurementRequestId);
    expect(fake.getAction()?.status).toBe("executed");
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
    expect(fake.getEvents().map((e) => e.event_type)).toContain("intelligence.action.failed");
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

  it("a failed action can be retried and reaches executed", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ status: "failed", failure_reason: "insert failed" }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("executed");
    expect(fake.getRequestInsertCount()).toBe(1);
    expect(fake.getAction()?.failure_reason).toBeNull();
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
      // restaurant.menu.reprice_review has an executor as of I6 (see the
      // describe block far below) — this test needs a type this module
      // genuinely still doesn't execute.
      action: actionRow({ action_type: "restaurant.kitchen.staffing_review" }),
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

  it("never breaks the business action when the event writer fails", async () => {
    const fake = makeFakeSupabase({
      action: actionRow(),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      failEventInsert: true,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result.status).toBe("executed");
    expect(fake.getAction()?.status).toBe("executed");
    expect(fake.getEvents()).toHaveLength(0); // every emit attempt failed, silently
  });
});

const EXECUTED_ACTION = actionRow({
  status: "executed",
  result: { procurement_request_id: "req-verify-1", procurement_request_status: "draft" },
  queued_at: "2026-01-01T00:00:00.000Z",
  executing_at: "2026-01-01T00:00:01.000Z",
  completed_at: "2026-01-01T00:00:02.000Z",
});

function draftRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-verify-1",
    tenant_id: TENANT_A,
    correlation_id: EXECUTED_ACTION.id,
    status: "draft",
    ...overrides,
  };
}

function requestItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-verify-1",
    purchase_request_id: "req-verify-1",
    inventory_item_id: INVENTORY_ITEM_ID,
    quantity: 30,
    ...overrides,
  };
}

describe("verifyRestaurantAction — Verify", () => {
  it("positively confirms success: real request, right tenant, right correlation, right item/quantity, still draft, no duplicate", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest()],
      existingItems: [requestItem()],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toEqual({
      verified: true,
      outcome: "purchase_request_created",
      entityType: "purchase_request",
      entityId: "req-verify-1",
      expectedQuantity: 30,
      actualQuantity: 30,
      status: "draft",
    });
    expect(fake.getAction()?.status).toBe("verified");
    expect(fake.getAction()?.verified_at).toBeTruthy();
    expect(fake.getAction()?.verification_result).toEqual(result);
    expect(fake.getEvents().map((e) => e.event_type)).toEqual(["intelligence.action.verified"]);
  });

  it("detects a wrong quantity (expected 30, found 20)", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest()],
      existingItems: [requestItem({ quantity: 20 })],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({
      verified: false,
      outcome: "quantity_mismatch",
      expectedQuantity: 30,
      actualQuantity: 20,
    });
    expect(fake.getAction()?.status).toBe("verification_failed");
    expect(fake.getEvents().map((e) => e.event_type)).toEqual([
      "intelligence.action.verification_failed",
    ]);
  });

  it("detects a missing purchase request", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [], // never actually created / vanished
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({ verified: false, outcome: "purchase_request_missing" });
    expect(fake.getAction()?.status).toBe("verification_failed");
  });

  it("detects a wrong tenant on the resulting request", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest({ tenant_id: TENANT_B })],
      existingItems: [requestItem()],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({ verified: false, outcome: "tenant_mismatch" });
  });

  it("detects a wrong item on the request", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest()],
      existingItems: [requestItem({ inventory_item_id: OTHER_ITEM_ID })],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({ verified: false, outcome: "item_missing" });
  });

  it("detects a wrong correlation (request exists but isn't linked to this action)", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest({ correlation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })],
      existingItems: [requestItem()],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({ verified: false, outcome: "correlation_mismatch" });
  });

  it("detects an unexpected status (already submitted, no longer the governed draft)", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest({ status: "submitted" })],
      existingItems: [requestItem()],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({
      verified: false,
      outcome: "unexpected_status",
      status: "submitted",
    });
  });

  it("detects a duplicate request correlated to the same action", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest(), draftRequest({ id: "req-verify-2" })],
      existingItems: [requestItem()],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });

    expect(result).toMatchObject({ verified: false, outcome: "duplicate_request" });
  });

  it("refuses to verify an action that has not executed yet", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({ status: "approved" }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toEqual({
      verified: false,
      outcome: "not_executed",
      reason: expect.stringMatching(/has not executed/i),
    });
    expect(fake.getAction()?.status).toBe("approved"); // untouched
  });

  it("reports verification unavailable for an action type with no verifier, and does not pretend it was verified", async () => {
    const fake = makeFakeSupabase({
      // restaurant.inventory.replenish_review (I5) and
      // restaurant.menu.reprice_review (I6) both have verifiers now — this
      // test needs a type this module genuinely still doesn't execute, same
      // as the "no executor registered" case above.
      action: actionRow({
        action_type: "restaurant.kitchen.staffing_review",
        status: "executed",
        result: { procurement_request_id: "n/a" },
      }),
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: actionRow().id,
    });

    expect(result).toEqual({
      verified: false,
      outcome: "verification_unavailable",
      reason: expect.stringMatching(/no verifier implemented/i),
    });
    // No status mutation, no event — we never checked, so we never claim to have.
    expect(fake.getAction()?.status).toBe("executed");
    expect(fake.getEvents()).toHaveLength(0);
  });

  it("refuses a caller outside the decision's tenant", async () => {
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "purchasing_officer" }],
      existingRequests: [draftRequest()],
      existingItems: [requestItem()],
    });

    await expect(
      verifyRestaurantAction(fake.supabase, MANAGER, { actionId: EXECUTED_ACTION.id }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
  });

  it("re-derives every value from the database — never trusts the action's cached result blindly", async () => {
    // The action's cached result says one thing; the real row on the
    // request says another (e.g. it was hand-edited after the fact).
    // Verify must report the actual database quantity, not the cached one.
    const fake = makeFakeSupabase({
      action: EXECUTED_ACTION,
      decision: decisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [draftRequest()],
      existingItems: [requestItem({ quantity: 30 })],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, {
      actionId: EXECUTED_ACTION.id,
    });
    expect(result.actualQuantity).toBe(30);
    // Confirm it came from a fresh read, not the action row: the fake only
    // ever returns items via a "restaurant_purchase_request_items" select.
    expect(
      fake.calls.some((c) => c.table === "restaurant_purchase_request_items" && c.op === "select"),
    ).toBe(true);
  });
});

/**
 * I5 — restaurant.inventory.replenish_review shares the exact same executor
 * and verifier as restaurant.purchase.suggest (runProcurementDraftExecution
 * / verifyProcurementDraft — see actions.server.ts's file doc comment), so
 * the bulk of Act/Verify behaviour above already covers it structurally.
 * This block proves specifically: the new action type actually executes
 * (was previously "no executor registered"), it works from an
 * inventory_shortage-shaped decision (not just purchasing_replenishment),
 * and the I5-specific failure modes — a shortage finding whose facts have
 * no matching purchasing suggestion (null quantity, or null supplier) —
 * fail safely rather than guessing.
 */
function shortageDecisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return decisionRow({
    decision_key: "restaurant.tenant.finding.inventory",
    context: {
      finding: {
        subject: "UAT reorder ingredient",
        headline: "UAT reorder ingredient is forecast to run out in 2 days",
        facts: {
          daysOfCover: 2,
          belowReorder: true,
          urgent: true,
          velocity: 10,
          inventoryItemId: INVENTORY_ITEM_ID,
          currentQuantity: 20,
          reorderPoint: 25,
          recommendedQuantity: 30,
          supplierId: SUPPLIER_ID,
          estimatedUnitCost: 1500,
          estimatedCost: 45000,
          currency: "TZS",
        },
      },
    },
    ...overrides,
  });
}

const REPLENISH_ACTION = actionRow({ action_type: "restaurant.inventory.replenish_review" });

describe("restaurant.inventory.replenish_review — I5", () => {
  it("executes from an inventory_shortage decision — the option catalogue's replenish_review action is no longer a dead end", async () => {
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result).toMatchObject({
      status: "executed",
      executionResult: "procurement_request_created",
      procurementRequestStatus: "draft",
    });
    const lineInsert = fake.calls.find(
      (c) => c.table === "restaurant_purchase_request_items" && c.op === "insert",
    );
    expect(lineInsert!.payload).toMatchObject({
      inventory_item_id: INVENTORY_ITEM_ID,
      preferred_supplier_id: SUPPLIER_ID,
      quantity: 30,
    });
    const requestInsert = fake.calls.find(
      (c) => c.table === "restaurant_purchase_requests" && c.op === "insert",
    );
    expect(requestInsert!.payload.status).toBe("draft"); // governed — stops at draft, never submitted/approved
  });

  it("verifies the resulting draft independently of the executor's own cached result", async () => {
    const executed = actionRow({
      action_type: "restaurant.inventory.replenish_review",
      status: "executed",
      result: { procurement_request_id: "req-replenish-1", procurement_request_status: "draft" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [
        {
          id: "req-replenish-1",
          tenant_id: TENANT_A,
          correlation_id: executed.id,
          status: "draft",
        },
      ],
      existingItems: [
        {
          id: "item-replenish-1",
          purchase_request_id: "req-replenish-1",
          inventory_item_id: INVENTORY_ITEM_ID,
          quantity: 30,
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({
      verified: true,
      outcome: "purchase_request_created",
      expectedQuantity: 30,
      actualQuantity: 30,
      status: "draft",
    });
  });

  it("detects a quantity mismatch on a verified replenish_review draft", async () => {
    const executed = actionRow({
      action_type: "restaurant.inventory.replenish_review",
      status: "executed",
      result: { procurement_request_id: "req-replenish-2", procurement_request_status: "draft" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [
        {
          id: "req-replenish-2",
          tenant_id: TENANT_A,
          correlation_id: executed.id,
          status: "draft",
        },
      ],
      existingItems: [
        {
          id: "item-replenish-2",
          purchase_request_id: "req-replenish-2",
          inventory_item_id: INVENTORY_ITEM_ID,
          quantity: 5,
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({
      verified: false,
      outcome: "quantity_mismatch",
      expectedQuantity: 30,
      actualQuantity: 5,
    });
  });

  it("detects a duplicate replenish_review draft correlated to the same action", async () => {
    const executed = actionRow({
      action_type: "restaurant.inventory.replenish_review",
      status: "executed",
      result: { procurement_request_id: "req-replenish-3", procurement_request_status: "draft" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequests: [
        {
          id: "req-replenish-3",
          tenant_id: TENANT_A,
          correlation_id: executed.id,
          status: "draft",
        },
        {
          id: "req-replenish-3b",
          tenant_id: TENANT_A,
          correlation_id: executed.id,
          status: "draft",
        },
      ],
      existingItems: [
        {
          id: "item-replenish-3",
          purchase_request_id: "req-replenish-3",
          inventory_item_id: INVENTORY_ITEM_ID,
          quantity: 30,
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({ verified: false, outcome: "duplicate_request" });
  });

  it("does not re-execute an already-executed replenish_review action (idempotent re-run)", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        action_type: "restaurant.inventory.replenish_review",
        status: "executed",
        result: { procurement_request_id: "already-there", procurement_request_status: "draft" },
      }),
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result).toMatchObject({ status: "executed", alreadyExecuted: true });
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("protects against two concurrent executions of the same replenish_review action", async () => {
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    const [a, b] = await Promise.all([
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPLENISH_ACTION.id }),
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPLENISH_ACTION.id }),
    ]);

    expect(fake.getRequests()).toHaveLength(1);
    expect(a.procurementRequestId).toBe(b.procurementRequestId);
  });

  it("recovers an existing replenish_review request by correlation_id after a partial failure", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        action_type: "restaurant.inventory.replenish_review",
        status: "executing",
        executing_at: "2026-01-01T00:00:00.000Z",
      }),
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
      existingRequestByCorrelation: {
        id: "recovered-replenish-id",
        tenant_id: TENANT_A,
        correlation_id: REPLENISH_ACTION.id,
        status: "draft",
      },
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result).toMatchObject({
      status: "executed",
      procurementRequestId: "recovered-replenish-id",
    });
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("refuses a caller outside the decision's tenant for a replenish_review action", async () => {
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "purchasing_officer" }],
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPLENISH_ACTION.id }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
  });

  it("fails the action when the caller lacks purchase.request capability", async () => {
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: WAITER, role: "waiter" }],
    });

    const result = await executeRestaurantAction(fake.supabase, WAITER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/purchase\.request.*requires/i);
  });

  it("fails safely on a shortage finding with no matching purchasing suggestion — null quantity, not a guess", async () => {
    // Mirrors the real gap: an item with no consumption velocity to project
    // from has no purchasing suggestion, so inventoryFindings (I5) leaves
    // recommendedQuantity/supplierId null rather than inventing a number.
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow({
        context: {
          finding: {
            subject: "Idle-stock item",
            headline: "Idle-stock item is already below its reorder point",
            facts: {
              daysOfCover: null,
              belowReorder: true,
              urgent: true,
              velocity: 0,
              inventoryItemId: INVENTORY_ITEM_ID,
              currentQuantity: 2,
              reorderPoint: 10,
              recommendedQuantity: null,
              supplierId: null,
              estimatedUnitCost: null,
              estimatedCost: null,
              currency: "TZS",
            },
          },
        },
      }),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no structured purchasing data/i);
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("fails safely on a shortage finding with a quantity but no supplier product on file", async () => {
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow({
        context: {
          finding: {
            subject: "No-supplier item",
            headline: "No-supplier item is forecast to run out in 2 days",
            facts: {
              daysOfCover: 2,
              belowReorder: true,
              urgent: true,
              velocity: 10,
              inventoryItemId: INVENTORY_ITEM_ID,
              currentQuantity: 20,
              reorderPoint: 25,
              recommendedQuantity: 30,
              supplierId: null,
              estimatedUnitCost: null,
              estimatedCost: null,
              currency: "TZS",
            },
          },
        },
      }),
      restaurantMembers: OWNER_MEMBER,
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPLENISH_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no supplier product on file/i);
    expect(fake.getRequestInsertCount()).toBe(0);
  });

  it("cross-tenant item id cannot be laundered through a replenish_review action — tenant is always the decision's, never client-suppliable", async () => {
    // The executor never accepts a tenant id from the caller; it is always
    // decision.tenant_id, re-derived server-side. Prove the request actually
    // lands under the decision's real tenant even when the finding
    // "subject" text looks like it could belong elsewhere.
    const fake = makeFakeSupabase({
      action: REPLENISH_ACTION,
      decision: shortageDecisionRow(),
      restaurantMembers: OWNER_MEMBER,
    });

    await executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPLENISH_ACTION.id });

    const requestInsert = fake.calls.find(
      (c) => c.table === "restaurant_purchase_requests" && c.op === "insert",
    );
    expect(requestInsert!.payload.tenant_id).toBe(TENANT_A);
  });
});

/**
 * I6 — restaurant.menu.reprice_review. A differently-shaped governed effect
 * from the other two action types (a restaurant_prices "pending_approval"
 * row, never a procurement draft), so it gets its own fixtures, but drives
 * through the exact same executeRestaurantAction/verifyRestaurantAction
 * dispatch, lifecycle, idempotency and capability-gate machinery — nothing
 * below is a second Act/Verify implementation.
 */
const MENU_ITEM_ID = "aaaaaaaa-1111-2222-3333-444444444444";
// pricing.manage (owner/general_manager/restaurant_manager/accountant) is
// what this executor itself requires — deliberately NOT pricing.approve
// (owner/general_manager only), proving the executor never needs, and never
// exercises, publish authority.
const PRICING_MEMBER = [{ tenant_id: TENANT_A, user_id: MANAGER, role: "restaurant_manager" }];

function repriceFindingFacts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    classification: "puzzle",
    marginPercent: 40,
    menuItemId: MENU_ITEM_ID,
    currentPrice: 12000,
    currency: "TZS",
    recommendedPrice: 14000,
    targetMarginPercent: 65,
    priceDelta: 2000,
    ...overrides,
  };
}

function repriceDecisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return decisionRow({
    decision_key: "restaurant.tenant.finding.menu",
    context: {
      finding: {
        subject: "UAT signature dish",
        headline:
          "UAT signature dish sells but does not carry its margin — current price TZS 12,000, proposed review price TZS 14,000 (requires approval before it takes effect)",
        facts: repriceFindingFacts(),
      },
    },
    ...overrides,
  });
}

const REPRICE_ACTION = actionRow({ action_type: "restaurant.menu.reprice_review" });

function menuItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: MENU_ITEM_ID, tenant_id: TENANT_A, price: 12000, currency: "TZS", ...overrides };
}

/** An active restaurant_prices override, matching the exact scope shape the executor's own current-price lookup queries (tenant scope, no property/location/price-list/channel). */
function activePriceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "existing-active-price",
    tenant_id: TENANT_A,
    menu_item_id: MENU_ITEM_ID,
    scope: "tenant",
    property_id: null,
    location_id: null,
    price_list_id: null,
    channel: null,
    status: "active",
    version: 1,
    amount: 12000,
    currency: "TZS",
    correlation_id: null,
    ...overrides,
  };
}

describe("restaurant.menu.reprice_review — I6", () => {
  it("creates a pending_approval pricing review from a menu_margin decision — never active, the live price never moves", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result).toMatchObject({
      status: "executed",
      executionResult: "price_review_created",
      priceReviewId: "created-review-id",
      priceReviewStatus: "pending_approval",
    });

    const insert = fake.calls.find((c) => c.table === "restaurant_prices" && c.op === "insert");
    expect(insert!.payload).toMatchObject({
      tenant_id: TENANT_A,
      menu_item_id: MENU_ITEM_ID,
      scope: "tenant",
      amount: 14000,
      currency: "TZS",
      status: "pending_approval",
      requires_approval: true,
      version: 1,
      supersedes_id: null,
      correlation_id: REPRICE_ACTION.id,
    });
    // The one governed effect really did stop at draft/review, not active.
    expect(fake.getPriceReviews()).toHaveLength(1);
    expect(fake.getPriceReviews()[0].status).toBe("pending_approval");

    // Same audit trail a human raising a price through the Pricing Centre gets.
    expect(
      fake.calls.some((c) => c.table === "restaurant_pricing_audit" && c.op === "insert"),
    ).toBe(true);

    const finalAction = fake.getAction();
    expect(finalAction?.status).toBe("executed");
    expect(finalAction?.result).toMatchObject({ price_review_id: "created-review-id" });
  });

  it("versions against, and supersedes_id references, an existing active override — never edits it in place", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
      existingPriceReviews: [activePriceRow({ version: 3 })],
    });

    await executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPRICE_ACTION.id });

    const insert = fake.calls.find((c) => c.table === "restaurant_prices" && c.op === "insert");
    expect(insert!.payload).toMatchObject({ version: 4, supersedes_id: "existing-active-price" });
    // The active row itself is never updated by this executor — only decidePrice() supersedes it, later, separately.
    expect(fake.calls.some((c) => c.table === "restaurant_prices" && c.op === "update")).toBe(
      false,
    );
    const active = fake.getPriceReviews().find((r) => r.id === "existing-active-price");
    expect(active?.status).toBe("active"); // completely untouched
  });

  it("verifies the resulting review independently of the executor's own cached result", async () => {
    const executed = actionRow({
      action_type: "restaurant.menu.reprice_review",
      status: "executed",
      result: { price_review_id: "review-verify-1", price_review_status: "pending_approval" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      existingPriceReviews: [
        {
          id: "review-verify-1",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: executed.id,
          amount: 14000,
          currency: "TZS",
          status: "pending_approval",
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({
      verified: true,
      outcome: "price_review_created",
      entityType: "price_review",
      expectedAmount: 14000,
      actualAmount: 14000,
      status: "pending_approval",
    });
  });

  it("reports verification_failed — not verified — if the review somehow reads 'active' instead of 'pending_approval'", async () => {
    // This must never happen through this executor, but Verify's job is to
    // positively confirm the actual database state, not assume it. An
    // active row here would mean an unintended live-price mutation, and
    // must be reported as a failure, never silently accepted.
    const executed = actionRow({
      action_type: "restaurant.menu.reprice_review",
      status: "executed",
      result: { price_review_id: "review-verify-2", price_review_status: "pending_approval" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      existingPriceReviews: [
        {
          id: "review-verify-2",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: executed.id,
          amount: 14000,
          currency: "TZS",
          status: "active",
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({
      verified: false,
      outcome: "unexpected_status",
      status: "active",
    });
  });

  it("detects an amount mismatch on the resulting review", async () => {
    const executed = actionRow({
      action_type: "restaurant.menu.reprice_review",
      status: "executed",
      result: { price_review_id: "review-verify-3", price_review_status: "pending_approval" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      existingPriceReviews: [
        {
          id: "review-verify-3",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: executed.id,
          amount: 13500,
          currency: "TZS",
          status: "pending_approval",
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({
      verified: false,
      outcome: "amount_mismatch",
      expectedAmount: 14000,
      actualAmount: 13500,
    });
  });

  it("detects a duplicate pricing review correlated to the same action", async () => {
    const executed = actionRow({
      action_type: "restaurant.menu.reprice_review",
      status: "executed",
      result: { price_review_id: "review-verify-4", price_review_status: "pending_approval" },
    });
    const fake = makeFakeSupabase({
      action: executed,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      existingPriceReviews: [
        {
          id: "review-verify-4",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: executed.id,
          amount: 14000,
          currency: "TZS",
          status: "pending_approval",
        },
        {
          id: "review-verify-4b",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: executed.id,
          amount: 14000,
          currency: "TZS",
          status: "pending_approval",
        },
      ],
    });

    const result = await verifyRestaurantAction(fake.supabase, MANAGER, { actionId: executed.id });

    expect(result).toMatchObject({ verified: false, outcome: "duplicate_review" });
  });

  it("does not re-execute an already-executed reprice_review action (idempotent re-run)", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        action_type: "restaurant.menu.reprice_review",
        status: "executed",
        result: { price_review_id: "already-there", price_review_status: "pending_approval" },
      }),
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result).toMatchObject({
      status: "executed",
      executionResult: "price_review_created",
      priceReviewId: "already-there",
      alreadyExecuted: true,
    });
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("protects against two concurrent executions of the same reprice_review action — exactly one review", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    const [a, b] = await Promise.all([
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPRICE_ACTION.id }),
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPRICE_ACTION.id }),
    ]);

    expect(fake.getPriceReviews()).toHaveLength(1);
    expect(a.priceReviewId).toBe(b.priceReviewId);
    expect(fake.getAction()?.status).toBe("executed");
  });

  it("recovers an existing review by correlation_id after a partial failure, without duplicating it", async () => {
    const fake = makeFakeSupabase({
      action: actionRow({
        action_type: "restaurant.menu.reprice_review",
        status: "executing",
        executing_at: "2026-01-01T00:00:00.000Z",
      }),
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
      existingPriceReviews: [
        {
          id: "recovered-review-id",
          tenant_id: TENANT_A,
          menu_item_id: MENU_ITEM_ID,
          correlation_id: REPRICE_ACTION.id,
          amount: 14000,
          currency: "TZS",
          status: "pending_approval",
        },
      ],
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result).toMatchObject({ status: "executed", priceReviewId: "recovered-review-id" });
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("refuses a caller outside the decision's tenant", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "restaurant_manager" }],
      menuItem: menuItemRow(),
    });

    await expect(
      executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPRICE_ACTION.id }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("fails the action when the caller lacks pricing.manage — an intelligence-decision approver is not automatically a pricing authority", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      // purchasing_officer can approve procurement, but not pricing.
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: MANAGER, role: "purchasing_officer" }],
      menuItem: menuItemRow(),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/pricing\.manage.*requires/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("STALE PRICE PROTECTION: refuses to raise a review when the live price has moved since the decision was generated", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(), // captured currentPrice: 12000
      restaurantMembers: PRICING_MEMBER,
      // The item's real price is now 13000, not the 12000 this decision saw.
      menuItem: menuItemRow({ price: 13000 }),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/stale price/i);
    expect(result.failureReason).toMatch(/12,?000/);
    expect(result.failureReason).toMatch(/13,?000/);
    // No destructive overwrite — nothing was ever created.
    expect(fake.getPriceReviewInsertCount()).toBe(0);
    expect(fake.getPriceReviews()).toHaveLength(0);
  });

  it("STALE PRICE PROTECTION: also fires when an active restaurant_prices override moved, even if restaurant_menu_items.price alone looks unchanged", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(), // captured currentPrice: 12000
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow({ price: 12000 }), // looks fresh...
      // ...but a scoped override is what's actually authoritative, and it has moved.
      existingPriceReviews: [activePriceRow({ amount: 12500 })],
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/stale price/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("refuses when the menu item's real currency no longer matches what the decision captured — never proposes cross-currency", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(), // captured currency: TZS
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow({ price: 12000, currency: "USD" }), // re-based to a different currency since
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/stale price/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("fails safely on a decision with no recommended price — never guesses one", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow({
        context: {
          finding: {
            subject: "No target margin set",
            headline: "No target margin set",
            facts: repriceFindingFacts({ recommendedPrice: null }),
          },
        },
      }),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no structured pricing data/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("fails safely on an invalid (zero/negative) proposed price", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow({
        context: {
          finding: {
            subject: "x",
            headline: "x",
            facts: repriceFindingFacts({ recommendedPrice: -500 }),
          },
        },
      }),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no structured pricing data/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("fails safely when the menu item does not exist for this tenant — cross-tenant/deleted item protection", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: null, // not found (wrong tenant, or deleted)
    });

    const result = await executeRestaurantAction(fake.supabase, MANAGER, {
      actionId: REPRICE_ACTION.id,
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/does not exist for this tenant/i);
    expect(fake.getPriceReviewInsertCount()).toBe(0);
  });

  it("never issues an UPDATE against restaurant_prices, restaurant_menu_items, or any order table — only ever an insert of a new review row", async () => {
    const fake = makeFakeSupabase({
      action: REPRICE_ACTION,
      decision: repriceDecisionRow(),
      restaurantMembers: PRICING_MEMBER,
      menuItem: menuItemRow(),
    });

    await executeRestaurantAction(fake.supabase, MANAGER, { actionId: REPRICE_ACTION.id });

    const mutatingCalls = fake.calls.filter(
      (c) =>
        c.op !== "select" &&
        c.table !== "intelligence_actions" &&
        c.table !== "intelligence_events" &&
        c.table !== "restaurant_pricing_audit",
    );
    expect(mutatingCalls).toEqual([
      expect.objectContaining({ table: "restaurant_prices", op: "insert" }),
    ]);
    expect(
      fake.calls.some(
        (c) => c.table.includes("restaurant_orders") || c.table.includes("restaurant_order_items"),
      ),
    ).toBe(false);
  });
});
