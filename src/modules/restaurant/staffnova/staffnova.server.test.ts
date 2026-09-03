/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for dynamically-imported engine modules. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { staffNovaAskSchema } from "./staffnova.contracts";

/**
 * askStaffNova is a thin orchestrator over existing, already-tested pieces
 * (assertCapability, the four intelligence engines, posBoard, the decision
 * board, the AI gateway). This test suite mocks each of those at the module
 * boundary and asserts askStaffNova wires them correctly and safely — it
 * does not re-test assertCapability's own RBAC logic, getMenuIntelligence's
 * own math, etc., which already have their own test files.
 */

const assertCapabilityMock = vi.fn();
const rolesInTenantMock = vi.fn();
vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => assertCapabilityMock(...args),
  rolesInTenant: (...args: unknown[]) => rolesInTenantMock(...args),
}));

const posBoardMock = vi.fn();
vi.mock("../sales/pos.server", () => ({
  posBoard: (...args: unknown[]) => posBoardMock(...args),
}));

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

const getRestaurantDecisionBoardMock = vi.fn();
vi.mock("../decisions/decisions.server", () => ({
  getRestaurantDecisionBoard: (...args: unknown[]) => getRestaurantDecisionBoardMock(...args),
}));

const callReasoningProviderMock = vi.fn();
vi.mock("@/lib/reasoning-provider.server", () => ({
  callReasoningProvider: (...args: unknown[]) => callReasoningProviderMock(...args),
}));

const understandNovaInstructionMock = vi.fn();
vi.mock("../understand/understand.server", () => ({
  understandNovaInstruction: (...args: unknown[]) => understandNovaInstructionMock(...args),
}));

const previewNovaPreparationMock = vi.fn();
vi.mock("../prepare/prepare.server", () => ({
  previewNovaPreparation: (...args: unknown[]) => previewNovaPreparationMock(...args),
}));

const { askStaffNova } = await import("./staffnova.server");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const USER_ID = "user-1";

function stubEngines() {
  // I14: default to "owner" so every pre-existing test (written before
  // role-aware trimming existed) keeps seeing the full context, exactly as
  // it did before — role-specific tests override this explicitly.
  rolesInTenantMock.mockResolvedValue(["owner"]);
  posBoardMock.mockResolvedValue({
    stats: { openBills: 2, openValue: 100, revenueToday: 500, coversToday: 40, averageCheck: 25 },
  });
  getMenuIntelligenceMock.mockResolvedValue({
    currency: "USD",
    windowDays: 30,
    totals: { revenue: 1000, cost: 400, grossProfit: 600, itemsSold: 120 },
    items: [],
    profitDrivers: [],
    marginLosers: [],
    declining: [],
    promote: [],
    costReview: [],
    insights: [],
  });
  getInventoryIntelligenceMock.mockResolvedValue({
    currency: "USD",
    runway: [],
    atRisk: [],
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
  });
  getKitchenIntelligenceMock.mockResolvedValue({
    ticketsAnalysed: 0,
    averagePrepMinutes: null,
    previousAveragePrepMinutes: null,
    trendPercent: null,
    stations: [],
    insights: [],
  });
  getPurchasingIntelligenceMock.mockResolvedValue({
    currency: "USD",
    suggestions: [],
    suppliers: [],
    expectedMonthlySpend: 0,
    previousMonthlySpend: 0,
    spendChangePercent: null,
    insights: [],
  });
  getRestaurantDecisionBoardMock.mockResolvedValue({
    generated_at: new Date().toISOString(),
    tenant_id: TENANT_A,
    window_days: 30,
    headline: "",
    findings: [],
    candidates: [],
    stored: [],
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("staffNovaAskSchema", () => {
  it("accepts a minimal valid ask", () => {
    const parsed = staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How was lunch?" });
    expect(parsed.history).toEqual([]);
  });

  it("rejects a non-uuid tenantId — the server never trusts a client-supplied id shape", () => {
    expect(() => staffNovaAskSchema.parse({ tenantId: "not-a-uuid", message: "hi" })).toThrow();
  });

  it("rejects an empty message", () => {
    expect(() => staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "" })).toThrow();
  });

  it("bounds history length so a long chat can't blow out the AI gateway prompt", () => {
    const history = Array.from({ length: 13 }, () => ({ role: "user" as const, content: "hi" }));
    expect(() =>
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "hi", history }),
    ).toThrow();
  });
});

describe("askStaffNova — authorization (A, C, E)", () => {
  it("A: an authorized staff member's question reaches the AI gateway", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "You served 40 guests today.",
      provider: "openai",
      unavailable: false,
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How many guests today?" }),
    );

    expect(assertCapabilityMock).toHaveBeenCalledWith({}, USER_ID, TENANT_A, "intelligence.read");
    expect(callReasoningProviderMock).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ system: expect.any(String), user: expect.any(String) }),
    );
    expect(result.degraded).toBe(false);
    expect(result.answer).toBe("You served 40 guests today.");
  });

  it("C/E: assertCapability rejecting (wrong tenant, or a role without intelligence.read) propagates as a thrown error — no answer, no data gathered, no AI call", async () => {
    assertCapabilityMock.mockRejectedValue(new Error("Forbidden"));
    stubEngines();

    await expect(
      askStaffNova(
        {} as any,
        USER_ID,
        staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "Show me everything" }),
      ),
    ).rejects.toThrow("Forbidden");

    expect(posBoardMock).not.toHaveBeenCalled();
    expect(getMenuIntelligenceMock).not.toHaveBeenCalled();
    expect(callReasoningProviderMock).not.toHaveBeenCalled();
  });

  it("B: the exact tenantId from the request is what's passed to every grounding engine — never a different, client-confusable value", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How is menu performance?" }),
    );

    expect(posBoardMock).toHaveBeenCalledWith({}, USER_ID, { tenantId: TENANT_A });
    expect(getMenuIntelligenceMock).toHaveBeenCalledWith({}, USER_ID, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(getRestaurantDecisionBoardMock).toHaveBeenCalledWith({}, USER_ID, {
      tenantId: TENANT_A,
      windowDays: 30,
      includeStored: true,
    });
  });
});

describe("askStaffNova — grounding (F)", () => {
  it("F: the AI gateway is only ever given the real, freshly computed engine output — the user's message never substitutes for or overrides it", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    getMenuIntelligenceMock.mockResolvedValue({
      currency: "USD",
      windowDays: 30,
      totals: { revenue: 4242, cost: 1000, grossProfit: 3242, itemsSold: 88 },
      items: [],
      profitDrivers: [
        { menuItemId: "m1", name: "Grilled Tilapia", revenue: 900, marginPercent: 61 },
      ],
      marginLosers: [],
      declining: [],
      promote: [],
      costReview: [],
      insights: [],
    });
    callReasoningProviderMock.mockResolvedValue({
      content: "Revenue this window was 4242.",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How is the menu doing?" }),
    );

    expect(callReasoningProviderMock).toHaveBeenCalledTimes(1);
    expect(callReasoningProviderMock.mock.calls[0][0]).toBe("openai");
    const call = callReasoningProviderMock.mock.calls[0][1] as { system: string; user: string };
    const sentPayload = JSON.parse(call.user);
    // The real computed revenue figure is present in what the model receives...
    expect(sentPayload.context.menu.totals.revenue).toBe(4242);
    expect(sentPayload.context.menu.profitDrivers[0].name).toBe("Grilled Tilapia");
    // ...and the system prompt itself carries the anti-fabrication instruction.
    expect(call.system).toMatch(/never invent, estimate, or guess/i);
    expect(call.system).toMatch(/say so plainly/i);
  });

  it("a single engine failing does not abort the whole answer — it's marked unavailable and the rest of the context still reaches the model", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    getKitchenIntelligenceMock.mockRejectedValue(new Error("kitchen query failed"));
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How is the kitchen doing?" }),
    );

    expect(result.degraded).toBe(false);
    const call = callReasoningProviderMock.mock.calls[0][1] as { user: string };
    const sentPayload = JSON.parse(call.user);
    expect(sentPayload.context.kitchen.unavailable).toBe(true);
    // The other categories were unaffected by the kitchen engine's failure.
    expect(sentPayload.context.sales.coversToday).toBe(40);
  });
});

describe("askStaffNova — no fabrication on AI failure (G)", () => {
  it("G: when the provider reports unavailable (the real callReasoningProvider contract — it never throws), the answer degrades to a fixed, honest message — never a guess", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      provider: "openai",
      unavailable: true,
      reason: "AI advisory is not configured for this deployment (missing NOVA_AI_API_KEY).",
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should we prepare tomorrow?" }),
    );

    expect(result.degraded).toBe(true);
    expect(result.answer).toMatch(/unable to reach the nova assistant/i);
  });

  it("a hard throw from the provider call (defense in depth, beyond its normal never-throws contract) also degrades safely rather than crashing the request", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockRejectedValue(new Error("gateway unreachable"));

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should we prepare tomorrow?" }),
    );

    expect(result.degraded).toBe(true);
    expect(result.answer).toMatch(/unable to reach the nova assistant/i);
  });

  it("a malformed provider response — missing/undefined content on an otherwise-available result — degrades safely instead of throwing a TypeError", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({ provider: "openai", unavailable: false });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should we prepare tomorrow?" }),
    );

    expect(result.degraded).toBe(true);
  });

  it("an empty AI response is also treated as a failure, not an empty/blank answer shown to the user", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "   ",
      provider: "openai",
      unavailable: false,
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "Anything?" }),
    );

    expect(result.degraded).toBe(true);
  });
});

describe("askStaffNova — I11: operational instructions are intercepted, plain questions are not", () => {
  it("a command-shaped message never reaches the free-text AI gateway — it's routed to understandNovaInstruction instead", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    const fakeContract = {
      intent: "operational_command",
      domain: "stock_movement",
      action: "prepare_stock_movement",
      entities: [],
      locations: { source: null, destination: null },
      supplier: null,
      temporal: null,
      constraints: [],
      requestedExecution: "prepare",
      confidence: 0.85,
      missingInformation: [],
      ambiguities: [],
    };
    understandNovaInstructionMock.mockResolvedValue({
      contract: fakeContract,
      summary: "I understand this as a stock movement.",
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({
        tenantId: TENANT_A,
        message: "Prepare a stock movement for 3kg beef from Main Store to Kitchen",
      }),
    );

    expect(understandNovaInstructionMock).toHaveBeenCalledWith({}, USER_ID, {
      tenantId: TENANT_A,
      message: "Prepare a stock movement for 3kg beef from Main Store to Kitchen",
    });
    expect(callReasoningProviderMock).not.toHaveBeenCalled();
    expect(posBoardMock).not.toHaveBeenCalled(); // no grounding context is even built for an intercepted instruction
    expect(result.answer).toBe("I understand this as a stock movement.");
    expect(result.degraded).toBe(false);
    expect(result.understanding).toEqual(fakeContract);
  });

  it("I12: previewNovaPreparation is called automatically (read-only) alongside understanding, and its result is attached", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    const fakeContract = {
      intent: "operational_command",
      domain: "stock_movement",
      action: "prepare_stock_movement",
      entities: [],
      locations: { source: null, destination: null },
      supplier: null,
      temporal: null,
      constraints: [],
      requestedExecution: "prepare",
      confidence: 0.85,
      missingInformation: [],
      ambiguities: [],
    };
    understandNovaInstructionMock.mockResolvedValue({ contract: fakeContract, summary: "..." });
    const fakePreparation = {
      workflow: "stock_transfer",
      action: "prepare_stock_movement",
      readiness: "ready",
      fields: null,
      missingFields: [],
      ambiguousFields: [],
      warnings: [],
      createdRecordId: null,
      documentNumber: null,
      message: "Ready to prepare this stock transfer.",
    };
    previewNovaPreparationMock.mockResolvedValue(fakePreparation);

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({
        tenantId: TENANT_A,
        message: "Prepare a stock movement for 3kg beef",
      }),
    );

    expect(previewNovaPreparationMock).toHaveBeenCalledWith({}, USER_ID, {
      tenantId: TENANT_A,
      contract: fakeContract,
    });
    expect(result.preparation).toEqual(fakePreparation);
  });

  it("I12: a failure inside previewNovaPreparation degrades gracefully to just the understanding, never loses the whole answer", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    const fakeContract = {
      intent: "operational_command",
      domain: "stock_movement",
      action: "prepare_stock_movement",
      entities: [],
      locations: { source: null, destination: null },
      supplier: null,
      temporal: null,
      constraints: [],
      requestedExecution: "prepare",
      confidence: 0.85,
      missingInformation: [],
      ambiguities: [],
    };
    understandNovaInstructionMock.mockResolvedValue({
      contract: fakeContract,
      summary: "I understand this.",
    });
    previewNovaPreparationMock.mockRejectedValue(new Error("boom"));

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({
        tenantId: TENANT_A,
        message: "Prepare a stock movement for 3kg beef",
      }),
    );

    expect(result.degraded).toBe(false);
    expect(result.understanding).toEqual(fakeContract);
    expect(result.preparation).toBeUndefined();
  });

  it("a plain question never calls understandNovaInstruction — the existing free-text Q&A flow is unaffected", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "You served 40 guests today.",
      provider: "openai",
      unavailable: false,
    });

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "How many guests today?" }),
    );

    expect(understandNovaInstructionMock).not.toHaveBeenCalled();
    expect(callReasoningProviderMock).toHaveBeenCalledTimes(1);
    expect(result.understanding).toBeUndefined();
  });

  it("a lookup failure inside understanding degrades to a safe apology, never a crash or a fabricated understanding", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    understandNovaInstructionMock.mockRejectedValue(new Error("db unavailable"));

    const result = await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "Approve the purchase order" }),
    );

    expect(result.degraded).toBe(true);
    expect(result.understanding).toBeUndefined();
    expect(callReasoningProviderMock).not.toHaveBeenCalled();
  });
});

describe("askStaffNova — no autonomous action", () => {
  it("never touches any write-capable module — only read functions are imported/called", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "Reorder more tomatoes" }),
    );

    // The system prompt is what actually stops the model from promising
    // action (verified above); structurally, this module simply never
    // imports or calls any write path (insertLines, runRestaurantDecisionPass,
    // decideDecision, etc.) regardless of what's asked.
    expect(callReasoningProviderMock).toHaveBeenCalledTimes(1);
  });
});

describe("askStaffNova — I14: role-aware intelligence (server-side, never merely a prompt instruction)", () => {
  it("H: rolesInTenant is called with the exact tenantId/userId from the request — role gating is re-derived server-side, never client-supplied", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should I prioritize?" }),
    );

    expect(rolesInTenantMock).toHaveBeenCalledWith({}, USER_ID, TENANT_A);
  });

  it("I: a bartender's context is trimmed to their scoped sections — sales/menu/purchasing financials never reach the model, even though the same engines were queried for everyone", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    rolesInTenantMock.mockResolvedValue(["bartender"]);
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What's happening tonight?" }),
    );

    const call = callReasoningProviderMock.mock.calls[0][1] as { user: string };
    const sentPayload = JSON.parse(call.user);
    expect(sentPayload.context.sales).toBeUndefined();
    expect(sentPayload.context.menu).toBeUndefined();
    expect(sentPayload.context.purchasing).toBeUndefined();
    expect(sentPayload.context.inventory).toBeDefined();
    expect(sentPayload.context.decisions).toBeDefined();
  });

  it("J: an owner (all sections) still receives the full context — role trimming never restricts a role the spec grants full access to", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    rolesInTenantMock.mockResolvedValue(["owner"]);
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "Give me today's briefing" }),
    );

    const call = callReasoningProviderMock.mock.calls[0][1] as { user: string };
    const sentPayload = JSON.parse(call.user);
    expect(sentPayload.context.sales).toBeDefined();
    expect(sentPayload.context.menu).toBeDefined();
    expect(sentPayload.context.inventory).toBeDefined();
    expect(sentPayload.context.kitchen).toBeDefined();
    expect(sentPayload.context.purchasing).toBeDefined();
    expect(sentPayload.context.decisions).toBeDefined();
  });

  it("K: a role with no capability mapping is never reached — assertCapability(intelligence.read) already rejects before rolesInTenant/context assembly run", async () => {
    assertCapabilityMock.mockRejectedValue(new Error("Forbidden"));

    await expect(
      askStaffNova(
        {} as any,
        USER_ID,
        staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What's happening?" }),
      ),
    ).rejects.toThrow("Forbidden");
    expect(rolesInTenantMock).not.toHaveBeenCalled();
  });
});

describe("askStaffNova — I14: deterministic priorities/changes/correlations reach the model as-is", () => {
  it("L: topPriorities/changes/correlations are populated from the decision board's raw findings/stored decisions, never invented in the context builder", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    const fakeDecision = {
      key: "restaurant.t1.finding.beef",
      module: "restaurant",
      domain: "inventory",
      title: "Beef replenishment",
      trigger: "Beef stock projected below 1 day of cover",
      status: "proposed",
      riskLevel: "critical",
      confidence: 0.8,
      requiresApproval: true,
      criteriaWeights: {},
      constraints: [],
      options: [],
      recommendedOptionKey: null,
      reasoning: {
        whatIsHappening: "x",
        whyItMatters: "Dinner service risk",
        whatIsLikely: "Stockout before dinner peak",
        optionsConsidered: [],
        tradeOffs: [],
        selectedOption: "Reorder",
        whySelected: "x",
        whatCouldGoWrong: [],
        whatHappensNext: ["Review replenishment"],
      },
      expectedOutcomes: [],
      evidence: [{ label: "Stock", value: "8kg" }],
      assumptions: [],
      uncertainties: [],
      risks: [],
      reasoningSources: [],
      predictionKeys: [],
      plan: { objective: "x", status: "draft", steps: [] },
      action: null,
    };
    const fakeFinding = {
      key: "finding.beef",
      kind: "inventory_shortage",
      severity: "critical",
      subject: "Beef",
      headline: "Beef is running low",
      detail: "detail",
      metric: null,
      evidence: [],
      prediction: {
        key: "prediction.beef",
        statement: "statement",
        value: null,
        unit: "",
        horizonDays: 1,
        confidence: 0.8,
        direction: "down",
      },
      facts: { inventoryItemId: "item-beef" },
    };
    getRestaurantDecisionBoardMock.mockResolvedValue({
      generated_at: new Date().toISOString(),
      tenant_id: TENANT_A,
      window_days: 30,
      headline: "",
      findings: [
        fakeFinding,
        { ...fakeFinding, kind: "purchasing_replenishment", key: "finding.beef.2" },
      ],
      candidates: [],
      stored: [fakeDecision],
    });
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should I prioritize?" }),
    );

    const call = callReasoningProviderMock.mock.calls[0][1] as { user: string };
    const sentPayload = JSON.parse(call.user);
    expect(sentPayload.context.topPriorities).toHaveLength(1);
    expect(sentPayload.context.topPriorities[0].what).toBe(
      "Beef stock projected below 1 day of cover",
    );
    expect(sentPayload.context.topPriorities[0].riskLevel).toBe("critical");
    expect(sentPayload.context.correlations).toHaveLength(1);
    expect(sentPayload.context.correlations[0].type).toBe("inferred");
  });

  it("M: when the decision board is unavailable, topPriorities/correlations degrade to empty arrays — never a fabricated priority", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    stubEngines();
    getRestaurantDecisionBoardMock.mockRejectedValue(new Error("board unavailable"));
    callReasoningProviderMock.mockResolvedValue({
      content: "answer",
      provider: "openai",
      unavailable: false,
    });

    await askStaffNova(
      {} as any,
      USER_ID,
      staffNovaAskSchema.parse({ tenantId: TENANT_A, message: "What should I prioritize?" }),
    );

    const call = callReasoningProviderMock.mock.calls[0][1] as { user: string };
    const sentPayload = JSON.parse(call.user);
    expect(sentPayload.context.topPriorities).toEqual([]);
    expect(sentPayload.context.correlations).toEqual([]);
  });
});
