/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows / mocked engine payloads are untyped at this boundary. */
/**
 * I10 — decision orchestration (reconciliation + resolution) tests.
 *
 * decisionLoop.server.test.ts already proves the REAL intelligence engines
 * (purchasing) turn real operational rows into a real persisted decision.
 * This file complements that by mocking the four intelligence engines at
 * the module boundary — the same "mock at the boundary, prove the wiring"
 * approach staffnova.server.test.ts uses — so each scenario can precisely
 * control one finding's severity/facts/presence across passes without
 * needing to fabricate the underlying orders/stock rows that would produce
 * it. gatherFindings/buildRestaurantDecisions themselves run for real: only
 * their inputs are controlled.
 *
 * The fake Supabase client below is deliberately more filter-precise than
 * decisionLoop's (select/update apply every .eq() filter, not just
 * decision_key) because the I10 resolution sweep's correctness depends on
 * status/tenant_id actually being respected, not just decision_key.
 */
import { describe, expect, it, vi } from "vitest";

const getMenuIntelligenceMock = vi.fn();
vi.mock("../intelligence/menu.server", () => ({
  getMenuIntelligence: (...args: unknown[]) => getMenuIntelligenceMock(...args),
}));
const getInventoryIntelligenceMock = vi.fn();
vi.mock("../intelligence/inventory.server", () => ({
  getInventoryIntelligence: (...args: unknown[]) => getInventoryIntelligenceMock(...args),
}));
const getKitchenIntelligenceMock = vi.fn();
vi.mock("../intelligence/kitchen.server", () => ({
  getKitchenIntelligence: (...args: unknown[]) => getKitchenIntelligenceMock(...args),
}));
const getPurchasingIntelligenceMock = vi.fn();
vi.mock("../intelligence/purchasing.server", () => ({
  getPurchasingIntelligence: (...args: unknown[]) => getPurchasingIntelligenceMock(...args),
}));

const { runRestaurantDecisionPass, getRestaurantDecisionBoard } =
  await import("./decisions.server");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const MANAGER = "22222222-2222-2222-2222-222222222222";
const VIEWER = "55555555-5555-5555-5555-555555555555";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";

const EMPTY_MENU = {
  currency: "USD",
  windowDays: 30,
  totals: { revenue: 0, cost: 0, grossProfit: 0, itemsSold: 0 },
  items: [],
  profitDrivers: [],
  marginLosers: [],
  declining: [],
  promote: [],
  costReview: [],
  insights: [],
};
const EMPTY_KITCHEN = {
  ticketsAnalysed: 0,
  averagePrepMinutes: null,
  previousAveragePrepMinutes: null,
  trendPercent: null,
  stations: [],
  insights: [],
};
const EMPTY_PURCHASING = {
  currency: "USD",
  suggestions: [],
  suppliers: [],
  expectedMonthlySpend: 0,
  previousMonthlySpend: 0,
  spendChangePercent: null,
  insights: [],
};

/** One inventory_shortage finding, or none at all (shortage resolved). */
function inventoryWith(atRisk: any[]) {
  return {
    currency: "USD",
    runway: [],
    atRisk,
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
  };
}

const SHORTAGE_ROW = {
  inventoryItemId: ITEM_ID,
  name: "Chicken stock",
  currentQuantity: 6,
  dailyVelocity: 2,
  daysOfCover: 3, // "medium" severity (SHORTAGE_DAYS=4, days>2 => medium)
  reorderPoint: 10,
  belowReorder: true,
};
const WORSENED_SHORTAGE_ROW = { ...SHORTAGE_ROW, daysOfCover: 1, currentQuantity: 2 }; // "critical"

function stubEngines(atRisk: any[]) {
  getMenuIntelligenceMock.mockResolvedValue(EMPTY_MENU);
  getInventoryIntelligenceMock.mockResolvedValue(inventoryWith(atRisk));
  getKitchenIntelligenceMock.mockResolvedValue(EMPTY_KITCHEN);
  getPurchasingIntelligenceMock.mockResolvedValue(EMPTY_PURCHASING);
}

/** A minimal, filter-precise fake — every .eq() actually narrows the result, and update() only touches matching rows. */
function makeFakeSb(members: Array<{ tenant_id: string; user_id: string; role: string }>) {
  const decisions = new Map<string, any>();
  const plans: any[] = [];
  let seq = 0;

  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" | "insert" = "select";
    let patch: any;
    let insertPayload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      order: () => api,
      limit: () => api,
      in: () => api,
      update: (p: any) => {
        mode = "update";
        patch = p;
        return api;
      },
      insert: (p: any) => {
        mode = "insert";
        insertPayload = p;
        return api;
      },
      maybeSingle: () => run(true),
      single: () => run(true),
      then: (onFulfilled: any, onRejected: any) => run(false).then(onFulfilled, onRejected),
    };

    async function run(single: boolean) {
      if (table === "restaurant_members") {
        const rows = members.filter(
          (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
        );
        return { data: rows, error: null };
      }
      if (table === "intelligence_plans") {
        if (mode === "insert") {
          seq += 1;
          const row = { id: `plan-${seq}`, ...insertPayload };
          plans.push(row);
          return { data: { id: row.id }, error: null };
        }
        return { data: single ? null : [], error: null };
      }
      if (table === "intelligence_plan_steps") {
        return { data: null, error: null };
      }
      if (table !== "intelligence_decisions") return { data: single ? null : [], error: null };

      let rows = Array.from(decisions.values());
      for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);

      if (mode === "select") {
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }
      if (mode === "insert") {
        seq += 1;
        const id = `decision-${seq}`;
        const row = { id, ...insertPayload };
        decisions.set(id, row);
        return { data: { id }, error: null };
      }
      if (mode === "update") {
        for (const r of rows) Object.assign(decisions.get(r.id), patch);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  return {
    sb: {
      from,
      rpc: async () => ({ data: false, error: null }),
    },
    decisions,
    plans,
  };
}

const OWNER_MEMBER = { tenant_id: TENANT_A, user_id: MANAGER, role: "owner" };
const VIEWER_MEMBER = { tenant_id: TENANT_A, user_id: VIEWER, role: "viewer" };

describe("I10 — new meaningful finding becomes a decision (A)", () => {
  it("a genuine inventory shortage produces one persisted, explainable decision", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);

    const result = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(result.decisionsRecorded).toBe(1);
    expect(result.decisionsUpdated).toBe(0);
    expect(result.decisionsExpired).toBe(0);
    expect(fake.decisions.size).toBe(1);

    const decision = Array.from(fake.decisions.values())[0];
    expect(decision.status).toBe("proposed");
    expect(decision.context.finding.kind).toBe("inventory_shortage");
    // Explainability (section 12): whyItMatters/evidence/options/trigger/
    // recommended option all present on the persisted row, unchanged shape.
    expect(decision.trigger).toBeTruthy();
    expect(decision.reasoning.whyItMatters).toBeTruthy();
    expect(decision.reasoning.optionsConsidered.length).toBeGreaterThan(0);
    expect(decision.evidence.length).toBeGreaterThan(0);
    expect(decision.recommended_option_key).toBeTruthy();
  });
});

describe("I10 — same finding repeated, no duplicate (B)", () => {
  it("running the pass again with an unchanged finding records nothing new", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);

    const first = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(first.decisionsRecorded).toBe(1);
    expect(second.decisionsRecorded).toBe(0);
    expect(second.decisionsUpdated).toBe(0);
    expect(second.decisionsExpired).toBe(0);
    expect(fake.decisions.size).toBe(1);
  });
});

describe("I10 — multiple passes for the same underlying condition, one effective decision (C)", () => {
  it("three consecutive passes (simulating three batched events) leave exactly one decision row", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);

    for (let i = 0; i < 3; i++) {
      await runRestaurantDecisionPass(fake.sb, MANAGER, {
        tenantId: TENANT_A,
        windowDays: 30,
        persist: true,
      });
    }

    expect(fake.decisions.size).toBe(1);
    expect(fake.plans.length).toBe(1);
  });
});

describe("I10 — material change updates the same still-proposed decision (D)", () => {
  it("a worsened shortage (medium -> critical) refreshes the existing row in place, never a duplicate", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const before = Array.from(fake.decisions.values())[0];
    expect(before.risk_level).not.toBe("critical");

    stubEngines([WORSENED_SHORTAGE_ROW]);
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(second.decisionsRecorded).toBe(0);
    expect(second.decisionsUpdated).toBe(1);
    expect(fake.decisions.size).toBe(1); // still one row, not two

    const after = Array.from(fake.decisions.values())[0];
    expect(after.id).toBe(before.id); // same governance row
    expect(after.decision_key).toBe(before.decision_key); // same identity
    expect(after.risk_level).toBe("critical"); // now reflects reality
    expect(after.context.finding.facts.daysOfCover).toBe(1);
  });

  it("a cosmetic-only recompute (identical severity/facts) is NOT treated as a material change", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    // Same severity/facts, same row — a second pass over unchanged data.
    stubEngines([SHORTAGE_ROW]);
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(second.decisionsUpdated).toBe(0);
  });

  it("once a human has approved the decision, a material change never touches that row (human governance boundary)", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const decisionId = Array.from(fake.decisions.keys())[0];
    // Simulate decideDecision() having approved it — status moves past "proposed".
    fake.decisions.get(decisionId).status = "approved";
    fake.decisions.get(decisionId).risk_level = "medium";

    stubEngines([WORSENED_SHORTAGE_ROW]);
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(second.decisionsUpdated).toBe(0);
    expect(second.decisionsRecorded).toBe(0); // same decision_key, still not re-created
    expect(fake.decisions.get(decisionId).status).toBe("approved"); // untouched
    expect(fake.decisions.get(decisionId).risk_level).toBe("medium"); // untouched
  });
});

describe("I10 — disappeared finding resolves the decision non-destructively (E)", () => {
  it("a resolved shortage marks the still-proposed decision expired, never deletes it", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const decisionId = Array.from(fake.decisions.keys())[0];

    stubEngines([]); // shortage resolved — no longer at risk
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(second.decisionsExpired).toBe(1);
    expect(fake.decisions.has(decisionId)).toBe(true); // still present — nothing deleted
    expect(fake.decisions.get(decisionId).status).toBe("expired");
    // Full history preserved.
    expect(fake.decisions.get(decisionId).reasoning).toBeTruthy();
    expect(fake.decisions.get(decisionId).evidence.length).toBeGreaterThan(0);
  });

  it("an already-approved decision is never auto-expired even if its finding disappears", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const decisionId = Array.from(fake.decisions.keys())[0];
    fake.decisions.get(decisionId).status = "approved";

    stubEngines([]);
    const second = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(second.decisionsExpired).toBe(0);
    expect(fake.decisions.get(decisionId).status).toBe("approved");
  });
});

describe("I10 — tenant isolation and RBAC (F, G, H)", () => {
  it("F: a member of Tenant A cannot trigger a decision pass for Tenant B", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]); // only a member of TENANT_A

    await expect(
      runRestaurantDecisionPass(fake.sb, MANAGER, {
        tenantId: TENANT_B,
        windowDays: 30,
        persist: true,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.decisions.size).toBe(0);
  });

  it("G: a user with no membership row at all is rejected", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([]); // no members anywhere

    await expect(
      runRestaurantDecisionPass(fake.sb, "no-such-user", {
        tenantId: TENANT_A,
        windowDays: 30,
        persist: true,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("H: a member without intelligence.read (viewer) is rejected", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([VIEWER_MEMBER]);

    await expect(
      runRestaurantDecisionPass(fake.sb, VIEWER, {
        tenantId: TENANT_A,
        windowDays: 30,
        persist: true,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.decisions.size).toBe(0);
  });

  it("getRestaurantDecisionBoard enforces the same tenant membership boundary for read access", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);

    await expect(
      getRestaurantDecisionBoard(fake.sb, MANAGER, {
        tenantId: TENANT_B,
        windowDays: 30,
        includeStored: true,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});

describe("I10 — no automatic approval or action (I, J)", () => {
  it("I: a freshly recorded decision always starts as proposed, requiring approval — never pre-approved", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    const decision = Array.from(fake.decisions.values())[0];
    expect(decision.status).toBe("proposed");
    expect(decision.requires_approval).toBe(true);
    expect(decision.action_id).toBeUndefined();
  });

  it("J: runRestaurantDecisionPass never writes to intelligence_actions — only decisions/plans/plan_steps", async () => {
    stubEngines([SHORTAGE_ROW]);
    const calledTables = new Set<string>();
    const fake = makeFakeSb([OWNER_MEMBER]);
    const originalFrom = fake.sb.from;
    fake.sb.from = (table: string) => {
      calledTables.add(table);
      return originalFrom(table);
    };

    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    expect(calledTables.has("intelligence_actions")).toBe(false);
    expect(calledTables.has("restaurant_orders")).toBe(false);
    expect(calledTables.has("restaurant_purchase_orders")).toBe(false);
  });
});

describe("I10 — concurrent decision pass never duplicates a governed decision", () => {
  it("an insert that loses a real unique-constraint race is skipped gracefully, never counted or crashing the pass", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);

    // Simulate the DB-level `unique (tenant_id, module, decision_key)`
    // constraint (0011) rejecting a concurrent insert that raced past this
    // process's own select-then-insert check — the real backstop this
    // function relies on for the true concurrent-caller case.
    const originalFrom = fake.sb.from;
    let insertAttempts = 0;
    fake.sb.from = (table: string) => {
      const api = originalFrom(table);
      if (table !== "intelligence_decisions") return api;
      return {
        ...api,
        insert: (payload: any) => {
          insertAttempts += 1;
          if (insertAttempts === 1) {
            // First writer loses the race: a concurrent process already
            // committed this exact (tenant_id, module, decision_key).
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { message: "duplicate key value violates unique constraint" },
                }),
              }),
            };
          }
          return api.insert(payload);
        },
      };
    };

    const result = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    // The existing `if (error || !row) continue;` path (unmodified by I10)
    // absorbs the conflict — no throw, no double-count, no duplicate row.
    expect(result.decisionsRecorded).toBe(0);
    expect(fake.decisions.size).toBe(0);
  });
});

describe("I10 — severity/priority correctness", () => {
  it("a critical-severity finding produces a critical risk_level decision, not a fabricated or default one", async () => {
    stubEngines([{ ...SHORTAGE_ROW, daysOfCover: 1 }]); // <=1 day => "critical" per findings.ts
    const fake = makeFakeSb([OWNER_MEMBER]);

    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    const decision = Array.from(fake.decisions.values())[0];
    expect(decision.context.finding.severity).toBe("critical");
    expect(decision.risk_level).toBe("critical");
  });

  it("a medium-severity finding does not inflate to a higher risk_level than the evidence supports", async () => {
    stubEngines([SHORTAGE_ROW]); // daysOfCover=3 => "medium"
    const fake = makeFakeSb([OWNER_MEMBER]);

    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });

    const decision = Array.from(fake.decisions.values())[0];
    expect(decision.context.finding.severity).toBe("medium");
    expect(["low", "medium"]).toContain(decision.risk_level);
  });
});

describe("I10 — full decision lifecycle stays representable (K)", () => {
  it("proposed -> materially changed (updated in place) -> approved (untouched thereafter) -> resolved condition leaves it approved, not expired", async () => {
    stubEngines([SHORTAGE_ROW]);
    const fake = makeFakeSb([OWNER_MEMBER]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    const id = Array.from(fake.decisions.keys())[0];
    expect(fake.decisions.get(id).status).toBe("proposed");

    stubEngines([WORSENED_SHORTAGE_ROW]);
    await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    expect(fake.decisions.get(id).status).toBe("proposed"); // still awaiting review
    expect(fake.decisions.get(id).risk_level).toBe("critical"); // reflects the update

    // Human governance boundary: only decideDecision (untouched by I10)
    // would ever set this in the real system — simulated here directly.
    fake.decisions.get(id).status = "approved";

    stubEngines([]); // condition resolves after approval
    const finalPass = await runRestaurantDecisionPass(fake.sb, MANAGER, {
      tenantId: TENANT_A,
      windowDays: 30,
      persist: true,
    });
    expect(finalPass.decisionsExpired).toBe(0);
    expect(fake.decisions.get(id).status).toBe("approved");
  });
});
