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

function makeFakeSupabase() {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      gte(col: string, val: string) {
        filters.push((r) => r[col] >= val);
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
      insert: () => api,
      maybeSingle: async () => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => ({ data: null, error: { message: "not implemented in fake" } }),
      then: (resolve: (v: { data: any[]; error: any }) => unknown) => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }

  function source(table: string): any[] {
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
});
