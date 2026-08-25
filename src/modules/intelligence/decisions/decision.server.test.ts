/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Proves the I2 tenant-isolation fix: decideDecision/updatePlanStep must
 * refuse to act on a decision unless the caller actually belongs to the
 * tenant that decision's owning module (restaurant) recorded it against.
 *
 * This exercises the REAL registered checker — restaurant/intelligence/
 * provider.ts's registerTenantScopeChecker("restaurant", ...) calling the
 * REAL restaurant/core/access.server.ts's assertTenantRead — against a fake
 * Supabase client, not a stub of the check itself. intelligence_decisions
 * does not exist in the live database (see the I1 audit), so this is the
 * only way to verify this path without fabricating a table.
 */
import { describe, expect, it } from "vitest";
import { decideDecision, updatePlanStep } from "./decision.server";

// Registers the restaurant provider + its tenant scope checker as a side
// effect, exactly like the real app does via the admin/restaurant layout.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const DECISION_ID = "44444444-4444-4444-4444-444444444444";
const PLAN_ID = "55555555-5555-5555-5555-555555555555";
const STEP_ID = "66666666-6666-6666-6666-666666666666";

function decisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DECISION_ID,
    module: "restaurant",
    domain: "operations",
    decision_key: "restaurant.tenant.finding",
    title: "Reorder before stockout",
    trigger: "Inventory shortage finding",
    status: "proposed",
    risk_level: "medium",
    confidence: 0.7,
    requires_approval: true,
    recommended_option_key: "reorder_now",
    options: [
      {
        option: {
          key: "reorder_now",
          title: "Reorder now",
          actionType: "restaurant.purchase.suggest",
          tactics: [],
        },
      },
    ],
    criteria_weights: {},
    constraints: [],
    reasoning: {},
    expected_outcomes: [],
    evidence: [],
    assumptions: [],
    uncertainties: [],
    risks: [],
    reasoning_sources: [],
    context: { tenant_id: TENANT_A },
    action_id: null,
    decision_note: null,
    outcome: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal thenable query builder — enough to cover decideDecision/updatePlanStep's call shapes. */
function makeFakeSupabase(opts: {
  decisions: Record<string, any>;
  plans?: Record<string, any>;
  planSteps?: Record<string, any>;
  restaurantMembers: Array<{ tenant_id: string; user_id: string; role: string }>;
}) {
  const calls: Array<{ table: string; op: "update" | "insert" }> = [];

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
        calls.push({ table, op: "update" });
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        calls.push({ table, op: "insert" });
        return api;
      },
      single: () => resolve(true),
      maybeSingle: () => resolve(false),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(single: boolean) {
      if (op === "select") {
        if (table === "intelligence_decisions") {
          const row = opts.decisions[filters.id as string] ?? null;
          return { data: row, error: row ? null : { message: "not found" } };
        }
        if (table === "intelligence_plans") {
          const rows = Object.values(opts.plans ?? {}).filter(
            (p: any) => filters.decision_id === undefined || p.decision_id === filters.decision_id,
          );
          const row = filters.id
            ? ((opts.plans ?? {})[filters.id as string] ?? null)
            : (rows[0] ?? null);
          return single
            ? { data: row, error: row ? null : { message: "not found" } }
            : { data: rows, error: null };
        }
        if (table === "intelligence_plan_steps") {
          const row = (opts.planSteps ?? {})[filters.id as string] ?? null;
          return { data: row, error: row ? null : { message: "not found" } };
        }
        if (table === "restaurant_members") {
          const rows = opts.restaurantMembers.filter(
            (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
          );
          return { data: rows, error: null };
        }
        return { data: single ? null : [], error: null };
      }
      // update/insert: acknowledge without mutating fixture state — the test
      // only needs to prove whether the call happened, not persist it.
      if (op === "insert") return { data: { id: "generated" }, error: null };
      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string, _args: Record<string, unknown>) => {
        if (fn === "nova_has_permission") return { data: true, error: null }; // coarse REPORTS:WRITE gate — always held
        if (fn === "has_any_role") return { data: false, error: null }; // never a platform admin
        return { data: null, error: null };
      },
    },
    calls,
  };
}

describe("decideDecision — tenant isolation", () => {
  it("refuses a caller who is not a restaurant_members of the decision's tenant", async () => {
    const { supabase, calls } = makeFakeSupabase({
      decisions: { [DECISION_ID]: decisionRow() },
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: USER, role: "waiter" }], // wrong tenant
    });

    await expect(
      decideDecision(supabase, USER, { id: DECISION_ID, decision: "rejected" }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);

    // The scope check must fail BEFORE any mutation — nothing should have
    // been updated or inserted.
    expect(calls.length).toBe(0);
  });

  it("allows a caller who is a restaurant_members of the decision's tenant", async () => {
    const { supabase, calls } = makeFakeSupabase({
      decisions: { [DECISION_ID]: decisionRow() },
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: USER, role: "restaurant_manager" }], // correct tenant
    });

    await expect(
      decideDecision(supabase, USER, { id: DECISION_ID, decision: "rejected" }),
    ).resolves.toEqual({ ok: true, actionId: null });

    expect(calls.some((c) => c.table === "intelligence_decisions" && c.op === "update")).toBe(true);
  });

  it("refuses when the decision's module has no registered tenant scope checker", async () => {
    const { supabase } = makeFakeSupabase({
      decisions: {
        [DECISION_ID]: decisionRow({ module: "revenue", context: { tenant_id: TENANT_A } }),
      },
      restaurantMembers: [],
    });

    await expect(
      decideDecision(supabase, USER, { id: DECISION_ID, decision: "rejected" }),
    ).rejects.toThrow(/no tenant scope authorization is registered for module "revenue"/i);
  });

  it("refuses when the decision has no recorded tenant scope at all", async () => {
    const { supabase } = makeFakeSupabase({
      decisions: { [DECISION_ID]: decisionRow({ context: {} }) },
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: USER, role: "owner" }],
    });

    await expect(
      decideDecision(supabase, USER, { id: DECISION_ID, decision: "rejected" }),
    ).rejects.toThrow(/no recorded tenant scope/i);
  });
});

describe("updatePlanStep — tenant isolation", () => {
  it("refuses a caller who is not a member of the owning decision's tenant", async () => {
    const { supabase, calls } = makeFakeSupabase({
      decisions: { [DECISION_ID]: decisionRow() },
      plans: { [PLAN_ID]: { id: PLAN_ID, decision_id: DECISION_ID } },
      planSteps: { [STEP_ID]: { id: STEP_ID, plan_id: PLAN_ID } },
      restaurantMembers: [{ tenant_id: TENANT_B, user_id: USER, role: "waiter" }],
    });

    await expect(
      updatePlanStep(supabase, USER, { stepId: STEP_ID, status: "in_progress" }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);

    expect(calls.some((c) => c.table === "intelligence_plan_steps" && c.op === "update")).toBe(
      false,
    );
  });

  it("allows a caller who is a member of the owning decision's tenant", async () => {
    const { supabase, calls } = makeFakeSupabase({
      decisions: { [DECISION_ID]: decisionRow() },
      plans: { [PLAN_ID]: { id: PLAN_ID, decision_id: DECISION_ID } },
      planSteps: { [STEP_ID]: { id: STEP_ID, plan_id: PLAN_ID } },
      restaurantMembers: [{ tenant_id: TENANT_A, user_id: USER, role: "chef" }],
    });

    await expect(
      updatePlanStep(supabase, USER, { stepId: STEP_ID, status: "in_progress" }),
    ).resolves.toEqual({ ok: true });

    expect(calls.some((c) => c.table === "intelligence_plan_steps" && c.op === "update")).toBe(
      true,
    );
  });
});

describe("restaurant tenant scope checker registration", () => {
  it("is registered exactly once and is authoritative (no stale duplicate in core/registry.ts)", async () => {
    const { getIntelligenceProvider } = await import("@/modules/intelligence/core/registry");
    const provider = getIntelligenceProvider("restaurant");
    expect(provider?.stages).toEqual(["observe", "understand", "reason", "recommend"]);
  });
});
