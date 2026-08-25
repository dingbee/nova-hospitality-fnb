/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * recordEvent's tenant-scope dispatch (assertEventScope), exercised against
 * the REAL registered checker (restaurant/intelligence/provider.ts's
 * assertTenantRead), not a stub — same philosophy as decision.server.test.ts.
 * intelligence_events itself is proven live in I3-A's UAT (RLS insert/select
 * against the real database); this covers the application-layer dispatch
 * and idempotency logic a live probe can't isolate as precisely.
 */
import { describe, expect, it } from "vitest";
import { recordEvent } from "./events.server";
import { emitRestaurantEvent } from "@/modules/restaurant/events/emit.server";

// Registers the restaurant provider + its tenant scope checker, exactly
// like the real app does via the admin/restaurant layout's side-effect import.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

function makeFakeSupabase(opts: {
  members: Array<{ tenant_id: string; user_id: string; role: string }>;
  existingDedupeKeys?: Array<{ tenant_id: string | null; dedupe_key: string; id: string }>;
  insertShouldFail?: { code: string; message: string };
}) {
  const inserted: any[] = [];
  const rows = [...(opts.existingDedupeKeys ?? [])];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      maybeSingle: () => resolve(false),
      single: () => resolve(true),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(single: boolean) {
      if (op === "select") {
        if (table === "restaurant_members") {
          const matched = opts.members.filter(
            (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
          );
          return { data: matched, error: null };
        }
        if (table === "intelligence_events") {
          const match = rows.find(
            (r) =>
              r.dedupe_key === filters.dedupe_key &&
              (filters.tenant_id === undefined || r.tenant_id === filters.tenant_id),
          );
          return { data: match ?? null, error: null };
        }
        return { data: single ? null : [], error: null };
      }
      // insert
      if (opts.insertShouldFail) {
        return { data: null, error: opts.insertShouldFail };
      }
      const id = `generated-${inserted.length}`;
      inserted.push(payload);
      if (payload.dedupe_key)
        rows.push({ tenant_id: payload.tenant_id, dedupe_key: payload.dedupe_key, id });
      return { data: { id }, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        if (fn === "nova_has_permission") return { data: true, error: null };
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
    inserted,
  };
}

describe("recordEvent — tenant scope dispatch", () => {
  it("records an event for a caller who belongs to the named tenant", async () => {
    const { supabase, inserted } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
    });

    const result = await recordEvent(supabase, USER, {
      module: "restaurant",
      tenantId: TENANT_A,
      eventType: "restaurant.kitchen.ticket.fired",
      severity: "info",
      source: "restaurant-os",
      payload: { ticket_id: "t1" },
    });

    expect(result.duplicate).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tenant_id).toBe(TENANT_A);
    expect(inserted[0].payload).toEqual({ ticket_id: "t1" });
  });

  it("refuses a caller who does not belong to the named tenant", async () => {
    const { supabase, inserted } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_B, user_id: USER, role: "chef" }], // wrong tenant
    });

    await expect(
      recordEvent(supabase, USER, {
        module: "restaurant",
        tenantId: TENANT_A,
        eventType: "restaurant.kitchen.ticket.fired",
        severity: "info",
        source: "restaurant-os",
        payload: {},
      }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);

    expect(inserted).toHaveLength(0);
  });

  it("refuses when a tenantId is given for a module with no registered scope checker", async () => {
    const { supabase, inserted } = makeFakeSupabase({ members: [] });

    await expect(
      recordEvent(supabase, USER, {
        module: "revenue",
        tenantId: TENANT_A,
        eventType: "revenue.rate_changed",
        severity: "info",
        source: "system",
        payload: {},
      }),
    ).rejects.toThrow(/no tenant scope authorization is registered for module "revenue"/i);

    expect(inserted).toHaveLength(0);
  });

  it("returns the existing row instead of inserting when the dedupe key already exists for that tenant", async () => {
    const { supabase, inserted } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
      existingDedupeKeys: [{ tenant_id: TENANT_A, dedupe_key: "dupe-1", id: "existing-id" }],
    });

    const result = await recordEvent(supabase, USER, {
      module: "restaurant",
      tenantId: TENANT_A,
      eventType: "restaurant.kitchen.ticket.fired",
      severity: "info",
      source: "restaurant-os",
      payload: {},
      dedupeKey: "dupe-1",
    });

    expect(result).toEqual({ id: "existing-id", duplicate: true });
    expect(inserted).toHaveLength(0);
  });

  it("treats a unique-violation race on insert as a duplicate, not an error", async () => {
    const { supabase } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
      insertShouldFail: { code: "23505", message: "duplicate key" },
    });

    const result = await recordEvent(supabase, USER, {
      module: "restaurant",
      tenantId: TENANT_A,
      eventType: "restaurant.kitchen.ticket.fired",
      severity: "info",
      source: "restaurant-os",
      payload: {},
      dedupeKey: "raced-key",
    });

    expect(result.duplicate).toBe(true);
  });

  it("propagates a genuine insert error (not a unique violation) rather than swallowing it", async () => {
    const { supabase } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
      insertShouldFail: {
        code: "23502",
        message: "null value in column violates not-null constraint",
      },
    });

    await expect(
      recordEvent(supabase, USER, {
        module: "restaurant",
        tenantId: TENANT_A,
        eventType: "restaurant.kitchen.ticket.fired",
        severity: "info",
        source: "restaurant-os",
        payload: {},
      }),
    ).rejects.toThrow(/not-null constraint/i);
  });
});

describe("emitRestaurantEvent — never breaks the operational write", () => {
  it("reports delivered:true on a successful observation", async () => {
    const { supabase } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
    });

    const result = await emitRestaurantEvent(supabase, USER, {
      type: "restaurant.kitchen.ticket.fired",
      tenantId: TENANT_A,
      source: "restaurant-os",
      payload: { ticket_id: "t1" },
    } as any);

    expect(result.delivered).toBe(true);
    expect(result.duplicate).toBe(false);
  });

  it("swallows a cross-tenant rejection and reports delivered:false without throwing", async () => {
    const { supabase } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_B, user_id: USER, role: "chef" }], // wrong tenant
    });

    const result = await emitRestaurantEvent(supabase, USER, {
      type: "restaurant.kitchen.ticket.fired",
      tenantId: TENANT_A,
      source: "restaurant-os",
      payload: {},
    } as any);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/do not belong to this restaurant tenant/i);
  });

  it("swallows a genuine implementation defect the same way — the caller never sees it throw", async () => {
    const { supabase } = makeFakeSupabase({
      members: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
      insertShouldFail: {
        code: "23502",
        message: "null value in column violates not-null constraint",
      },
    });

    const result = await emitRestaurantEvent(supabase, USER, {
      type: "restaurant.kitchen.ticket.fired",
      tenantId: TENANT_A,
      source: "restaurant-os",
      payload: {},
    } as any);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not-null constraint/i);
  });
});
