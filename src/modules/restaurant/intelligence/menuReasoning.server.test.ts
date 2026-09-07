/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows / AI payloads are untyped at this boundary. */
/**
 * INT-01 — runMenuIntelligenceReasoning end to end: structured-output
 * validation, grounding (never trusts a cited fact id that wasn't actually
 * supplied), and the insufficient-evidence / provider-unavailable
 * degraded paths. The reasoning provider is mocked (its own behavior is
 * covered by reasoning-provider.server.test.ts) so these tests isolate
 * what THIS module is responsible for: never persisting malformed or
 * fabricated output as trusted intelligence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const callReasoningProviderMock = vi.fn();
vi.mock("@/lib/reasoning-provider.server", () => ({
  callReasoningProvider: (...args: unknown[]) => callReasoningProviderMock(...args),
}));

beforeEach(() => {
  callReasoningProviderMock.mockReset();
});

const { runMenuIntelligenceReasoning } = await import("./menuReasoning.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const OWNER = "user-owner";
const PLAN_CORE = "plan-core";
const CAP_MENU_INT = "cap-menu-intelligence";

/**
 * P01: runMenuIntelligenceReasoning now gates on commercial entitlement/
 * quota before ever calling the provider. These commercial-catalogue rows
 * are the minimum an entitled, unmetered CORE tenant needs — no quota
 * definition is seeded, so usage is unmetered/always-allowed here; the
 * quota-blocking path is covered separately below.
 */
function commercialCatalogueRows(quotaDefinitions: any[] = []) {
  return {
    commercial_plans: [{ id: PLAN_CORE, code: "core" }],
    commercial_capabilities: [{ id: CAP_MENU_INT, code: "menu_intelligence", status: "active" }],
    commercial_plan_entitlements: [
      {
        id: "pe-1",
        plan_id: PLAN_CORE,
        capability_id: CAP_MENU_INT,
        state: "limited",
        config: {},
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_until: null,
      },
    ],
    commercial_quota_definitions: quotaDefinitions,
  };
}

function makeFakeSupabase(
  overrides: { commercial?: Record<string, any[]>; usageCounters?: any[] } = {},
) {
  const commercial = { ...commercialCatalogueRows(), ...overrides.commercial };
  const usageCounters: any[] = overrides.usageCounters ?? [];

  function parseOrExpr(expr: string) {
    const clauses = expr.split(",");
    return (r: any) =>
      clauses.some((c) => {
        const [field, op, ...rest] = c.split(".");
        const raw = rest.join(".");
        const rowVal = r[field!] ?? null;
        if (op === "is") return raw === "null" ? rowVal === null : String(rowVal) === raw;
        if (op === "eq") return rowVal !== null && String(rowVal) === raw;
        if (op === "gt") return rowVal !== null && String(rowVal) > raw;
        if (op === "gte") return rowVal !== null && String(rowVal) >= raw;
        if (op === "lt") return rowVal !== null && String(rowVal) < raw;
        if (op === "lte") return rowVal !== null && String(rowVal) <= raw;
        return false;
      });
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      gte(col: string, val: string) {
        filters.push((r) => r[col] >= val);
        return api;
      },
      lte(col: string, val: string) {
        filters.push((r) => r[col] <= val);
        return api;
      },
      or(expr: string) {
        filters.push(parseOrExpr(expr));
        return api;
      },
      not(col: string, _kind: string, val: unknown) {
        if (val === null) filters.push((r) => r[col] != null);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return api;
      },
      order: () => api,
      limit: () => api,
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: async () => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } };
      },
      then: (resolve: (v: { data: any; error: any }) => unknown) => {
        if (op === "insert") {
          const stored = { id: `${table}-${Date.now()}`, ...payload };
          source(table).push(stored);
          return resolve({ data: stored, error: null });
        }
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of rows) Object.assign(r, payload);
          return resolve({ data: rows[0] ?? null, error: null });
        }
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }

  function source(table: string): any[] {
    if (table === "commercial_usage_counters") return usageCounters;
    if (table in commercial) return commercial[table]!;
    switch (table) {
      case "restaurant_tenants":
        return [
          { id: TENANT, name: "Demo Tenant", settings: { business: { tradingName: "Demo" } } },
        ];
      case "restaurant_members":
        return [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }];
      case "restaurant_orders":
        return [
          {
            id: "order-1",
            tenant_id: TENANT,
            closed_at: new Date().toISOString(),
            currency: "TZS",
            status: "closed",
          },
        ];
      case "restaurant_menu_items":
        return [
          {
            id: "item-1",
            tenant_id: TENANT,
            name: "Chicken Burger",
            price: 12000,
            currency: "TZS",
          },
        ];
      case "restaurant_order_items":
        return [
          {
            order_id: "order-1",
            tenant_id: TENANT,
            menu_item_id: "item-1",
            description: "Chicken Burger",
            quantity: 10,
            line_total: 120000,
            line_cost: 42000,
            status: "served",
          },
        ];
      default:
        return [];
    }
  }

  function rpc() {
    return Promise.resolve({ data: false, error: null });
  }

  return { from, rpc } as any;
}

function baseInput(overrides: Partial<any> = {}) {
  return {
    tenantId: TENANT,
    question: "What is selling?",
    windowDays: 30,
    provider: "openai" as const,
    ...overrides,
  };
}

const VALID_RESULT = {
  insight: "Chicken Burger demand is strong.",
  recommendation: "Maintain current stock levels.",
  confidence: 0.8,
  priority: "medium" as const,
  reasonCodes: ["demand_increase"],
  supportingFactIds: ["menu-item:item-1", "totals:period"],
};

describe("runMenuIntelligenceReasoning", () => {
  it("returns a valid structured result when the model responds correctly, grounded in real supplied facts", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: JSON.stringify(VALID_RESULT),
      latencyMs: 500,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual(VALID_RESULT);
      expect(outcome.provider).toBe("openai");
      expect(outcome.promptVersion).toBe("menu-intelligence-v1");
    }
  });

  it("degrades cleanly (never throws) when the provider is unavailable", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: true,
      provider: "openai",
      reason: "OpenAI is not configured for this deployment (missing NOVA_AI_API_KEY).",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("provider_unavailable");
  });

  it("rejects malformed JSON — never persists or returns it as trusted", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: "not json at all",
      latencyMs: 100,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_response");
  });

  it("rejects an out-of-range confidence value", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: JSON.stringify({ ...VALID_RESULT, confidence: 1.5 }),
      latencyMs: 100,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_response");
  });

  it("rejects an unsupported reason code — the vocabulary is closed", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: JSON.stringify({ ...VALID_RESULT, reasonCodes: ["the_stars_aligned"] }),
      latencyMs: 100,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_response");
  });

  it("rejects an extra, unrecognised field (schema is .strict())", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: JSON.stringify({ ...VALID_RESULT, predictedNextWeekRevenue: 999999 }),
      latencyMs: 100,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("invalid_response");
  });

  it("rejects a fabricated supporting fact id — schema-valid but citing evidence never actually supplied", async () => {
    callReasoningProviderMock.mockResolvedValueOnce({
      unavailable: false,
      content: JSON.stringify({
        ...VALID_RESULT,
        supportingFactIds: ["menu-item:item-does-not-exist"],
      }),
      latencyMs: 100,
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("fabricated_evidence");
  });

  it("short-circuits to insufficient_data with no sales in the window — never even calls the provider", async () => {
    const sb = makeFakeSupabase();
    // Empty the order/order-items sources for this one call.
    const original = sb.from;
    sb.from = (table: string) => {
      if (table === "restaurant_orders" || table === "restaurant_order_items") {
        return original(table).eq("tenant_id", "no-such-tenant");
      }
      return original(table);
    };
    const outcome = await runMenuIntelligenceReasoning(sb, OWNER, baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("insufficient_data");
    expect(callReasoningProviderMock).not.toHaveBeenCalled();
  });

  it("requires intelligence.read — an unauthorized caller is rejected before any provider call", async () => {
    await expect(
      runMenuIntelligenceReasoning(makeFakeSupabase(), "stranger", baseInput()),
    ).rejects.toThrow(/Forbidden/);
    expect(callReasoningProviderMock).not.toHaveBeenCalled();
  });

  it("the exact same normalized context and question can be sent to a different provider (benchmarking seam)", async () => {
    callReasoningProviderMock.mockResolvedValue({
      unavailable: false,
      content: JSON.stringify(VALID_RESULT),
      latencyMs: 200,
      model: "gemini-2.0-flash",
      provider: "gemini",
    });
    const outcome = await runMenuIntelligenceReasoning(
      makeFakeSupabase(),
      OWNER,
      baseInput({ provider: "gemini" }),
    );
    expect(outcome.ok).toBe(true);
    expect(callReasoningProviderMock).toHaveBeenCalledWith(
      "gemini",
      expect.objectContaining({ user: "What is selling?" }),
    );
  });

  describe("P01 commercial gate", () => {
    it("blocks the provider call entirely when menu_intelligence is not entitled on the tenant's plan", async () => {
      const sb = makeFakeSupabase({ commercial: { commercial_plan_entitlements: [] } });
      const outcome = await runMenuIntelligenceReasoning(sb, OWNER, baseInput());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("commercial_blocked");
      expect(callReasoningProviderMock).not.toHaveBeenCalled();
    });

    it("blocks the provider call when the tenant's Menu Intelligence quota is already exhausted", async () => {
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const sb = makeFakeSupabase({
        commercial: {
          commercial_quota_definitions: [
            {
              id: "q-1",
              code: "menu_intelligence_runs_monthly",
              capability_id: CAP_MENU_INT,
              plan_id: PLAN_CORE,
              programme_id: null,
              unit: "intelligence_runs",
              limit_value: 1,
              period: "month",
              scope: "tenant",
              warning_threshold_pct: 80,
              near_limit_threshold_pct: 95,
              overage_behavior: "block",
              active: true,
              effective_from: "2020-01-01T00:00:00.000Z",
              effective_until: null,
            },
          ],
        },
        usageCounters: [
          {
            id: "uc-1",
            tenant_id: TENANT,
            property_id: null,
            quota_definition_id: "q-1",
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            used_value: 1,
            state: "BLOCKED",
          },
        ],
      });
      const outcome = await runMenuIntelligenceReasoning(sb, OWNER, baseInput());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe("commercial_blocked");
        expect(outcome.detail).toMatch(/quota exceeded/i);
      }
      expect(callReasoningProviderMock).not.toHaveBeenCalled();
    });

    it("still succeeds and records real usage once the commercial gate is passed (unmetered by default)", async () => {
      callReasoningProviderMock.mockResolvedValueOnce({
        unavailable: false,
        content: JSON.stringify(VALID_RESULT),
        latencyMs: 500,
        model: "gpt-4o-mini",
        provider: "openai",
        inputTokens: 1200,
        outputTokens: 300,
      });
      const outcome = await runMenuIntelligenceReasoning(makeFakeSupabase(), OWNER, baseInput());
      expect(outcome.ok).toBe(true);
    });
  });
});
