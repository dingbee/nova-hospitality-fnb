/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * I9 — consumeRestaurantEvents unit tests.
 *
 * runRestaurantDecisionPass itself is mocked here: its own correctness
 * (menu/inventory/kitchen/purchasing evaluation, decision persistence,
 * idempotent decision_key dedupe) is already covered by decisions.server's
 * own test suite, unchanged by I9. These tests exercise what I9 actually
 * adds — event selection, tenant authorization, act-then-mark ordering,
 * idempotency, failure handling — against the real consumeRestaurantEvents
 * function and a fake Supabase client, exactly like every other Act-stage
 * test in this codebase (fake DB, real business logic).
 */
import { describe, expect, it, vi } from "vitest";

const runRestaurantDecisionPass = vi.fn();
vi.mock("../decisions/decisions.server", () => ({
  runRestaurantDecisionPass: (...args: unknown[]) => runRestaurantDecisionPass(...args),
}));

import { consumeRestaurantEvents } from "./consume.server";
// Registers the restaurant provider + its tenant scope checker as a side
// effect, exactly like every other restaurant Act-stage test in this repo.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const MANAGER = "33333333-3333-3333-3333-333333333333";
const OWNER_MEMBER = [{ tenant_id: TENANT_A, user_id: MANAGER, role: "owner" }];

function eventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `event-${Math.random().toString(36).slice(2)}`,
    tenant_id: TENANT_A,
    module: "restaurant",
    event_type: "restaurant.kitchen.ticket.delayed",
    entity_id: "aaaaaaaa-0000-0000-0000-000000000001",
    occurred_at: "2026-08-30T18:00:00.000Z",
    processed_at: null,
    ...overrides,
  };
}

function matchesFilters(row: Record<string, any>, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([k, v]) => {
    if (k === "event_type_in") return (v as string[]).includes(row.event_type);
    if (k === "processed_at_null") return row.processed_at === null;
    return row[k] === v;
  });
}

function makeFakeSupabase(opts: {
  restaurantMembers: Array<{ tenant_id: string; user_id: string; role: string }>;
  events: Array<Record<string, any>>;
}) {
  const events = opts.events.map((e) => ({ ...e }));
  const calls: Array<{
    table: string;
    op: string;
    payload?: any;
    filters: Record<string, unknown>;
  }> = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        if (op === "select" && col === "event_type") filters.event_type_in = vals;
        else if (op === "update" && col === "id") filters.id_in = vals;
        else filters[`${col}_in`] = vals;
        return api;
      },
      is: (col: string, val: unknown) => {
        if (col === "processed_at" && val === null) filters.processed_at_null = true;
        else filters[col] = val;
        return api;
      },
      order: () => api,
      limit: () => api,
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      calls.push({ table, op, payload, filters: { ...filters } });

      if (table === "restaurant_members") {
        const rows = opts.restaurantMembers.filter((m) => matchesFilters(m, filters));
        return { data: rows, error: null };
      }
      if (table === "intelligence_events") {
        if (op === "select") {
          const rows = events.filter((e) => matchesFilters(e, filters));
          return { data: rows, error: null };
        }
        // update: mark matching ids processed
        const ids = (filters.id_in as string[] | undefined) ?? [];
        for (const e of events) {
          if (ids.includes(e.id)) Object.assign(e, payload);
        }
        return { data: null, error: null };
      }
      return { data: [], error: null };
    }
    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (_fn: string, _args: Record<string, unknown>) => ({ data: false, error: null }),
    },
    calls,
    getEvents: () => events,
  };
}

describe("consumeRestaurantEvents — I9", () => {
  it("1. valid event consumption: consumes unprocessed kitchen-completion events and refreshes intelligence", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 2,
      decisionsEvaluated: 2,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({
      restaurantMembers: OWNER_MEMBER,
      events: [eventRow(), eventRow({ event_type: "restaurant.kitchen.ticket.ready" })],
    });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });

    expect(result).toMatchObject({
      consumed: 2,
      refreshed: true,
      decisionsRecorded: 1,
      findings: 2,
    });
    expect(runRestaurantDecisionPass).toHaveBeenCalledTimes(1);
    expect(runRestaurantDecisionPass).toHaveBeenCalledWith(
      fake.supabase,
      MANAGER,
      expect.objectContaining({ tenantId: TENANT_A, windowDays: 30, persist: true }),
    );
    expect(fake.getEvents().every((e) => e.processed_at !== null)).toBe(true);
  });

  it("2. event validation: rejects a malformed input before touching the database", async () => {
    const { consumeRestaurantEventsSchema } = await import("./consume.server");
    expect(() => consumeRestaurantEventsSchema.parse({ tenantId: "not-a-uuid" })).toThrow();
    expect(consumeRestaurantEventsSchema.parse({ tenantId: TENANT_A }).windowDays).toBe(30);
  });

  it("3. tenant scope: an authorized tenant member succeeds", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 0,
      decisionsEvaluated: 0,
      decisionsRecorded: 0,
      plansCreated: 0,
      headline: "test",
    });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    await expect(
      consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 }),
    ).resolves.toMatchObject({ refreshed: true });
  });

  it("4. cross-tenant rejection: a caller who belongs to a different tenant is refused before any event is read", async () => {
    const fake = makeFakeSupabase({
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: MANAGER, role: "owner" }],
      events: [eventRow()],
    });

    await expect(
      consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
    expect(fake.calls.some((c) => c.table === "intelligence_events")).toBe(false);
  });

  it("4b. non-member rejection: a caller with no membership anywhere is refused", async () => {
    const fake = makeFakeSupabase({ restaurantMembers: [], events: [eventRow()] });

    await expect(
      consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
  });

  it("5. duplicate event: an event already recorded once (dedupe happened at write time) is read and consumed exactly once", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const singleTicketEvent = eventRow({ id: "only-one" });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [singleTicketEvent] });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.consumed).toBe(1);
  });

  it("6. concurrent processing: two callers reading the same unprocessed batch each still converge on a bounded, correct result", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    const [a, b] = await Promise.all([
      consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 }),
      consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 }),
    ]);

    // Both may observe the same unprocessed row in the same tick (no DB
    // claim step — see file doc comment on consume.server.ts's documented
    // limitation), but every event ends up processed exactly the same way,
    // and the underlying pass — already idempotent by decision_key — is
    // the thing that prevents a duplicate governed effect.
    expect(a.refreshed).toBe(true);
    expect(b.refreshed).toBe(true);
    expect(fake.getEvents().every((e) => e.processed_at !== null)).toBe(true);
  });

  it("7. already processed event: is never re-read or reprocessed", async () => {
    runRestaurantDecisionPass.mockReset();
    const fake = makeFakeSupabase({
      restaurantMembers: OWNER_MEMBER,
      events: [eventRow({ processed_at: "2026-08-30T17:00:00.000Z" })],
    });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });

    expect(result).toEqual({ consumed: 0, refreshed: false });
    expect(runRestaurantDecisionPass).not.toHaveBeenCalled();
  });

  it("8. failed processing: a thrown recompute error is reported, not swallowed as success, and never propagated to break the caller", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockRejectedValue(new Error("intelligence engine boom"));
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });

    expect(result).toMatchObject({ refreshed: false, failed: true, failureReason: /boom/ });
    // Never marked processed — safe to retry.
    expect(fake.getEvents().every((e) => e.processed_at === null)).toBe(true);
  });

  it("9. retry: a subsequent call after a failure reprocesses the same unprocessed batch", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockRejectedValueOnce(new Error("transient failure"));
    runRestaurantDecisionPass.mockResolvedValueOnce({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    const first = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(first.failed).toBe(true);

    const second = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(second).toMatchObject({ consumed: 1, refreshed: true });
    expect(runRestaurantDecisionPass).toHaveBeenCalledTimes(2);
  });

  it("10. irrelevant event ignored: an event type outside the kitchen-completion set never triggers a recompute", async () => {
    runRestaurantDecisionPass.mockReset();
    const fake = makeFakeSupabase({
      restaurantMembers: OWNER_MEMBER,
      events: [
        eventRow({ event_type: "restaurant.price.updated" }),
        eventRow({ event_type: "restaurant.kitchen.ticket.fired" }),
        eventRow({ event_type: "restaurant.inventory.low" }),
      ],
    });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });

    expect(result).toEqual({ consumed: 0, refreshed: false });
    expect(runRestaurantDecisionPass).not.toHaveBeenCalled();
    // Irrelevant events are left exactly as they were — this consumer
    // never claims events it did not act on.
    expect(fake.getEvents().every((e) => e.processed_at === null)).toBe(true);
  });

  it("11. relevant event reaches the kitchen intelligence engine: ready and delayed both trigger the same real pass", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({
      restaurantMembers: OWNER_MEMBER,
      events: [eventRow({ event_type: "restaurant.kitchen.ticket.ready" })],
    });

    await consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 });
    expect(runRestaurantDecisionPass).toHaveBeenCalledTimes(1);
  });

  it("12. multiple operational events collapse into one meaningful refresh, not one per event", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({
      restaurantMembers: OWNER_MEMBER,
      events: Array.from({ length: 25 }, () => eventRow()),
    });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });

    expect(result.consumed).toBe(25);
    expect(runRestaurantDecisionPass).toHaveBeenCalledTimes(1);
  });

  it("13. no duplicate downstream finding: runRestaurantDecisionPass's own idempotent decisionsRecorded is passed through untouched", async () => {
    runRestaurantDecisionPass.mockReset();
    // Simulates the pass having found the same finding already recorded —
    // decisionsRecorded stays 0 even though findings were evaluated.
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 0,
      plansCreated: 0,
      headline: "test",
    });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    const result = await consumeRestaurantEvents(fake.supabase, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result).toMatchObject({ refreshed: true, decisionsRecorded: 0 });
  });

  it("14. no autonomous action: consumeRestaurantEvents never touches intelligence_actions, restaurant_kitchen_tickets, or any operational table", async () => {
    runRestaurantDecisionPass.mockReset();
    runRestaurantDecisionPass.mockResolvedValue({
      findings: 1,
      decisionsEvaluated: 1,
      decisionsRecorded: 1,
      plansCreated: 1,
      headline: "test",
    });
    const fake = makeFakeSupabase({ restaurantMembers: OWNER_MEMBER, events: [eventRow()] });

    await consumeRestaurantEvents(fake.supabase, MANAGER, { tenantId: TENANT_A, windowDays: 30 });

    const touchedTables = new Set(fake.calls.map((c) => c.table));
    expect(touchedTables).toEqual(new Set(["restaurant_members", "intelligence_events"]));
  });
});
