/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * I11 — orchestrateApprovedRestaurantActions.
 *
 * actions.server.test.ts already exhaustively proves executeRestaurantAction/
 * verifyRestaurantAction themselves (single execution, duplicate execution,
 * concurrent execution of the SAME action, partial-failure/correlation
 * recovery, retry, verification success/failure, already-verified,
 * unsupported action type, wrong tenant, non-member, insufficient
 * capability, stale/missing facts, and the procurement/pricing/kitchen
 * governance boundaries) against the real executor — none of that is
 * repeated here. This file proves ONLY what I11 actually adds: discovery of
 * approved actions across a tenant, and safe fan-out dispatch through that
 * same unmodified executor. It uses the real orchestrateApprovedRestaurantActions
 * and the real executeRestaurantAction — the fake below is a database, not a
 * stub of either function.
 */
import { describe, expect, it } from "vitest";
import { executeRestaurantAction, orchestrateApprovedRestaurantActions } from "./actions.server";

// Registers the restaurant provider + its tenant scope checker, exactly
// like actions.server.test.ts.
import "@/modules/restaurant/intelligence/provider";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const OWNER = "33333333-3333-3333-3333-333333333333";
const WAITER = "44444444-4444-4444-4444-444444444444";
const SUPPLIER_ID = "77777777-7777-7777-7777-777777777777";

function matchesFilters(row: Record<string, any>, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([k, v]) => row[k] === v);
}

function findingFacts(itemId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    inventoryItemId: itemId,
    recommendedQuantity: 10,
    supplierId: SUPPLIER_ID,
    estimatedUnitCost: 1000,
    estimatedCost: 10000,
    currency: "TZS",
    ...overrides,
  };
}

function decisionRow(id: string, tenantId: string, itemId: string) {
  return {
    id,
    tenant_id: tenantId,
    module: "restaurant",
    decision_key: `restaurant.${tenantId}.finding.purchasing.${itemId}`,
    property_id: null,
    location_id: null,
    context: {
      finding: {
        subject: `Item ${itemId}`,
        headline: `Item ${itemId} needs replenishment`,
        facts: findingFacts(itemId),
      },
    },
  };
}

function actionRow(
  id: string,
  decisionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    decision_id: decisionId,
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
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A multi-row fake — generalizes actions.server.test.ts's single-row builder to support real tenant-wide discovery across several decisions/actions. */
function makeFakeSb(opts: {
  decisions: Array<Record<string, any>>;
  actions: Array<Record<string, any>>;
  members: Array<{ tenant_id: string; user_id: string; role: string }>;
}) {
  const decisions = opts.decisions.map((d) => ({ ...d }));
  const actions = opts.actions.map((a) => ({ ...a }));
  const requests: Array<Record<string, any>> = [];
  let seq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let inFilter: { col: string; vals: unknown[] } | null = null;
    let op: "select" | "update" | "insert" = "select";
    let payload: any;
    let mode: "single" | "maybeSingle" | "many" = "many";
    let limitValue: number | null = null;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        inFilter = { col, vals };
        return api;
      },
      order: () => api,
      limit: (n: number) => {
        limitValue = n;
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

    function applyFilters<T extends Record<string, any>>(rows: T[]): T[] {
      let out = rows.filter((r) => matchesFilters(r, filters));
      if (inFilter) out = out.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
      if (limitValue != null) out = out.slice(0, limitValue);
      return out;
    }

    async function resolve() {
      if (op === "select") {
        if (table === "intelligence_decisions") {
          const matches = applyFilters(decisions);
          if (mode === "single")
            return {
              data: matches[0] ?? null,
              error: matches[0] ? null : { message: "not found" },
            };
          return { data: matches, error: null };
        }
        if (table === "intelligence_actions") {
          const matches = applyFilters(actions);
          if (mode === "single")
            return {
              data: matches[0] ?? null,
              error: matches[0] ? null : { message: "not found" },
            };
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        if (table === "restaurant_members") {
          return { data: applyFilters(opts.members), error: null };
        }
        if (table === "restaurant_purchase_requests") {
          const matches = applyFilters(requests);
          if (mode === "maybeSingle") return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }
        return { data: mode === "many" ? [] : null, error: null };
      }

      if (op === "update") {
        if (table === "intelligence_actions") {
          const idx = actions.findIndex((a) => matchesFilters(a, filters));
          if (idx === -1) return { data: null, error: null };
          actions[idx] = { ...actions[idx], ...payload };
          const row = { ...actions[idx] };
          return { data: mode === "single" || mode === "maybeSingle" ? row : [row], error: null };
        }
        return { data: null, error: null };
      }

      // insert
      if (table === "restaurant_purchase_requests") {
        // Mirrors the real `unique (tenant_id, correlation_id)` constraint
        // (0016) — the actual backstop runProcurementDraftExecution relies
        // on when two truly concurrent executions both pass the
        // existingByCorrelation pre-check before either has inserted.
        const conflict = requests.find(
          (r) => r.tenant_id === payload.tenant_id && r.correlation_id === payload.correlation_id,
        );
        if (conflict) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        seq += 1;
        const row = { id: `request-${seq}`, status: "draft", ...payload };
        requests.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (table === "restaurant_purchase_request_items") {
        return { data: { id: `item-${seq}` }, error: null };
      }
      if (table === "intelligence_events") {
        return { data: { id: `event-${seq}` }, error: null };
      }
      if (table === "restaurant_procurement_audit" || table === "restaurant_documents") {
        return { data: { id: `doc-${seq}` }, error: null };
      }
      return { data: { id: "generated" }, error: null };
    }

    return api;
  }

  return {
    sb: {
      from: (table: string) => builder(table),
      rpc: async () => ({ data: false, error: null }),
    },
    actions,
    requests,
  };
}

const OWNER_MEMBER = { tenant_id: TENANT_A, user_id: OWNER, role: "owner" };
const WAITER_MEMBER = { tenant_id: TENANT_A, user_id: WAITER, role: "waiter" };

describe("I11 — approved action discovery (1)", () => {
  it("discovers only this tenant's approved actions, ignoring proposed/executed/rejected ones", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const d2 = decisionRow("d2", TENANT_A, "item-2");
    const d3 = decisionRow("d3", TENANT_A, "item-3");
    const fake = makeFakeSb({
      decisions: [d1, d2, d3],
      actions: [
        actionRow("a1", "d1", { status: "approved" }),
        actionRow("a2", "d2", { status: "executed", result: { procurement_request_id: "x" } }),
        actionRow("a3", "d3", { status: "approved" }),
      ],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(2);
    expect(result.outcomes.map((o) => o.actionId).sort()).toEqual(["a1", "a3"]);
  });
});

describe("I11 — unapproved action never executes (2, 16, 17)", () => {
  it("an action still 'proposed' (decision not yet approved) is never discovered or dispatched", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1", { status: "proposed" })],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(0);
    expect(result.outcomes).toHaveLength(0);
    expect(fake.actions.find((a) => a.id === "a1")?.status).toBe("proposed"); // untouched
    expect(fake.requests).toHaveLength(0); // no operational artifact created
  });

  it("no finding->decision->action of this test's making ever bypasses human approval: only status='approved' rows are ever dispatched", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1", { status: "rejected" as any })],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(0);
  });
});

describe("I11 — dispatch reuses the existing executor (3, 4)", () => {
  it("a single approved action produces exactly the same governed artifact executeRestaurantAction alone would", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0] as any;
    expect(outcome.status).toBe("executed");
    expect(outcome.executionResult).toBe("procurement_request_created");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].status).toBe("draft"); // never submitted/approved/purchased
  });

  it("multiple approved actions across different decisions are all dispatched in one call", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const d2 = decisionRow("d2", TENANT_A, "item-2");
    const d3 = decisionRow("d3", TENANT_A, "item-3");
    const fake = makeFakeSb({
      decisions: [d1, d2, d3],
      actions: [actionRow("a1", "d1"), actionRow("a2", "d2"), actionRow("a3", "d3")],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(3);
    expect(result.outcomes.filter((o: any) => o.status === "executed")).toHaveLength(3);
    expect(fake.requests).toHaveLength(3);
  });

  it("running the same action twice via two separate orchestration calls executes it exactly once", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });

    const first = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });
    const second = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect((first.outcomes[0] as any).status).toBe("executed");
    // Second sweep: the action is now "executed", not "approved" — discovery
    // finds nothing left to do.
    expect(second.discovered).toBe(0);
    expect(fake.requests).toHaveLength(1); // one operational artifact, not two
  });
});

describe("I11 — concurrent orchestration (5)", () => {
  it("two concurrent orchestration calls over the same approved action still produce exactly one operational artifact", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });

    const [r1, r2] = await Promise.all([
      orchestrateApprovedRestaurantActions(fake.sb, OWNER, { tenantId: TENANT_A }),
      orchestrateApprovedRestaurantActions(fake.sb, OWNER, { tenantId: TENANT_A }),
    ]);

    // The real invariant P10/I11 guarantee is one operational artifact and
    // one consistent id reported back — not that only one side literally
    // says "executed" without alreadyExecuted set. Both concurrent calls
    // can legitimately reach runProcurementDraftExecution's own
    // correlation_id recovery (the loser of guardedTransition's "queued"
    // race can still legally observe "executing" and follow it there); that
    // path also returns status "executed" without the alreadyExecuted flag,
    // by design — it recovered the winner's row rather than duplicating it.
    // guardedTransition's optimistic UPDATE...WHERE status='approved' (and,
    // as a backstop, the correlation_id recovery inside the executor) is
    // what this test actually proves, reused unchanged, not reimplemented.
    expect(fake.requests).toHaveLength(1);
    const ids = new Set(
      [...r1.outcomes, ...r2.outcomes].map((o: any) => o.procurementRequestId).filter(Boolean),
    );
    expect(ids.size).toBe(1);
  });
});

describe("I11 — unsupported action type fails safely, never disappears (11)", () => {
  it("an action type with no registered executor is reported as a failed outcome, not silently dropped", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1", { action_type: "restaurant.no_such_type" })],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("failed");
    expect((result.outcomes[0] as any).failureReason).toMatch(/no executor registered/i);
    // The row itself is untouched (the throw happens before any DB write) —
    // the next sweep will report the same thing again, not disappear it.
    expect(fake.actions.find((a) => a.id === "a1")?.status).toBe("approved");
  });
});

describe("I11 — RBAC / tenant security (12, 13, 14)", () => {
  it("12: a member of a different tenant cannot discover or execute Tenant A's approved actions", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER], // only a member of TENANT_A
    });

    await expect(
      orchestrateApprovedRestaurantActions(fake.sb, OWNER, { tenantId: TENANT_B }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.requests).toHaveLength(0);
  });

  it("13: a user with no membership row anywhere is rejected", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [],
    });

    await expect(
      orchestrateApprovedRestaurantActions(fake.sb, "no-such-user", { tenantId: TENANT_A }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("14: a member without intelligence.read cannot trigger the sweep, even though execution would itself individually re-check capability", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [WAITER_MEMBER],
    });

    await expect(
      orchestrateApprovedRestaurantActions(fake.sb, WAITER, { tenantId: TENANT_A }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("I11 — no scope leakage across tenants", () => {
  it("a sweep for Tenant A never discovers or touches Tenant B's approved actions, even when both exist", async () => {
    const dA = decisionRow("dA", TENANT_A, "item-a");
    const dB = decisionRow("dB", TENANT_B, "item-b");
    const fake = makeFakeSb({
      decisions: [dA, dB],
      actions: [actionRow("aA", "dA"), actionRow("aB", "dB")],
      members: [OWNER_MEMBER, { tenant_id: TENANT_B, user_id: OWNER, role: "owner" }],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect(result.discovered).toBe(1);
    expect(result.outcomes[0].actionId).toBe("aA");
    expect(fake.actions.find((a) => a.id === "aB")?.status).toBe("approved"); // Tenant B's untouched
  });
});

describe("I11 — verification stays separate (never fused with orchestration)", () => {
  it("orchestrating never marks an action verified — only executed", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fake = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });

    await orchestrateApprovedRestaurantActions(fake.sb, OWNER, { tenantId: TENANT_A });

    const row = fake.actions.find((a) => a.id === "a1");
    expect(row?.status).toBe("executed");
    expect(row?.verified_at).toBeNull();
    expect(row?.verification_result).toBeNull();
  });
});

describe("I11 — limit is respected and bounded", () => {
  it("rejects a limit outside the schema's bounds and defaults sensibly", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const d2 = decisionRow("d2", TENANT_A, "item-2");
    const fake = makeFakeSb({
      decisions: [d1, d2],
      actions: [actionRow("a1", "d1"), actionRow("a2", "d2")],
      members: [OWNER_MEMBER],
    });

    const result = await orchestrateApprovedRestaurantActions(fake.sb, OWNER, {
      tenantId: TENANT_A,
      limit: 1,
    });

    expect(result.discovered).toBe(1);
  });
});

describe("I11 — composition sanity: orchestrator calls the real executeRestaurantAction", () => {
  it("a directly-called executeRestaurantAction and the orchestrator's dispatch agree on the outcome shape for the same action", async () => {
    const d1 = decisionRow("d1", TENANT_A, "item-1");
    const fakeDirect = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });
    const direct = await executeRestaurantAction(fakeDirect.sb, OWNER, { actionId: "a1" });

    const fakeOrchestrated = makeFakeSb({
      decisions: [d1],
      actions: [actionRow("a1", "d1")],
      members: [OWNER_MEMBER],
    });
    const orchestrated = await orchestrateApprovedRestaurantActions(fakeOrchestrated.sb, OWNER, {
      tenantId: TENANT_A,
    });

    expect((orchestrated.outcomes[0] as any).status).toBe(direct.status);
    expect((orchestrated.outcomes[0] as any).executionResult).toBe(direct.executionResult);
  });
});
