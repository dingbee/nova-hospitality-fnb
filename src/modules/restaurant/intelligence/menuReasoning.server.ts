/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows / AI gateway payloads are untyped at this boundary. */
/**
 * INT-01 — Menu Intelligence reasoning: the first real LLM reasoning layer
 * in this codebase, answering "what's selling / what's profitable / what
 * should management do" from getMenuIntelligence()'s deterministic output.
 *
 * Architecture (see the INT-01 final report for the full verdict):
 *  - Facts: menuReasoningContext.server.ts, wrapping getMenuIntelligence()
 *    unmodified. Numbers are never recomputed here or by the model.
 *  - Reasoning: reasoning-provider.server.ts (OpenAI primary, Gemini
 *    challenger), itself a thin selector over the existing
 *    ai-gateway.server.ts — no second AI transport.
 *  - Structured output: menuReasoning.contracts.ts's zod schema. A response
 *    that fails validation, or cites a supportingFactId not present in the
 *    context actually supplied, is degraded to an explicit failure — never
 *    persisted as trusted intelligence.
 *  - Evaluation record: one intelligence_events row per run (module
 *    "restaurant", a new registered event type) — no new table. See
 *    events/contracts.ts.
 *
 * No autonomous action: this module only ever reads intelligence and calls
 * a reasoning provider. It never writes to intelligence_decisions,
 * intelligence_actions, or any restaurant operational table.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { callReasoningProvider, type ReasoningProviderName } from "@/lib/reasoning-provider.server";
import { parseAiJson } from "@/lib/ai-gateway.server";
import {
  buildMenuIntelligenceContext,
  factIdsOf,
  hashMenuIntelligenceContext,
  type MenuIntelligenceContext,
} from "./menuReasoningContext.server";
import {
  MENU_INTELLIGENCE_PROMPT_VERSION,
  MENU_REASON_CODES,
  menuReasoningResultSchema,
  type MenuReasoningResult,
  type RunMenuIntelligenceReasoningInput,
} from "./menuReasoning.contracts";

type Sb = any;

function buildSystemPrompt(context: MenuIntelligenceContext): string {
  return [
    `You are NOVA's Menu Intelligence reasoning layer for ${context.restaurant.businessName}.`,
    "",
    "Hard rules:",
    "- Answer ONLY using the facts in CONTEXT below. Never invent, estimate, or guess a price, quantity, cost, margin, supplier, staffing detail, or any number/fact not present in CONTEXT.",
    "- All numbers in CONTEXT were already computed by the restaurant's own deterministic systems. You interpret them; you never recalculate or restate them as if you derived them.",
    "- Distinguish evidence (a fact directly in CONTEXT) from inference (your interpretation of that evidence). Do not present an inference as if it were a supplied fact.",
    '- If CONTEXT has no sales data, or the question needs data CONTEXT does not contain, say plainly: "Insufficient evidence to make a reliable recommendation." This is the correct answer in that case, not a failure.',
    "- Every claim in reasonCodes must be one of the supplied codes; every id in supportingFactIds must be a factId that actually appears in CONTEXT.",
    "- You never claim an action was performed. You only ever produce an insight and a recommendation for a human to review — you cannot change prices, inventory, orders, or staffing.",
    "- Do not recommend a specific purchase/reprice quantity or percentage unless CONTEXT's own numbers (e.g. recommendedPrice, targetMarginPercent) support that specific figure.",
    "",
    `Respond with a single JSON object matching this exact shape (prompt version ${MENU_INTELLIGENCE_PROMPT_VERSION}):`,
    `{"insight": string, "recommendation": string, "confidence": number (0-1), "priority": "low"|"medium"|"high"|"critical", "reasonCodes": string[] (from: ${MENU_REASON_CODES.join(", ")}), "supportingFactIds": string[] (factId values from CONTEXT only)}`,
    "",
    `CONTEXT:\n${JSON.stringify(context)}`,
  ].join("\n");
}

export type MenuReasoningOutcome =
  | {
      ok: true;
      result: MenuReasoningResult;
      provider: ReasoningProviderName;
      model: string;
      latencyMs: number;
      promptVersion: string;
      contextHash: string;
      evaluationRecorded: boolean;
    }
  | {
      ok: false;
      reason:
        | "provider_unavailable"
        | "provider_error"
        | "invalid_response"
        | "fabricated_evidence"
        | "insufficient_data";
      detail: string;
      provider: ReasoningProviderName;
      promptVersion: string;
      contextHash: string | null;
      evaluationRecorded: boolean;
    };

/**
 * Validates a parsed model response beyond what the zod schema alone can
 * check: every cited supportingFactId must actually be a fact this exact
 * context supplied. A model can construct schema-valid JSON that still
 * references an id it invented — this closes that gap, the same
 * discipline selforder-asknova.ts's validateNovaResponse already
 * establishes for guest Ask NOVA (never trust a referenced id without
 * cross-checking it against the real, supplied set).
 */
function validateGrounding(
  parsed: MenuReasoningResult,
  context: MenuIntelligenceContext,
): { ok: true } | { ok: false; detail: string } {
  const real = factIdsOf(context);
  const fabricated = parsed.supportingFactIds.filter((id) => !real.has(id));
  if (fabricated.length > 0) {
    return {
      ok: false,
      detail: `Cited fact id(s) not present in the supplied context: ${fabricated.join(", ")}`,
    };
  }
  return { ok: true };
}

export async function runMenuIntelligenceReasoning(
  sb: Sb,
  userId: string,
  input: RunMenuIntelligenceReasoningInput,
  /** Test/benchmark seam — reuse an already-built context so two providers can be compared over byte-identical facts rather than two separately-fetched (though deterministically equivalent) contexts. */
  precomputedContext?: MenuIntelligenceContext,
): Promise<MenuReasoningOutcome> {
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const context = precomputedContext ?? (await buildMenuIntelligenceContext(sb, userId, input));
  const contextHash = hashMenuIntelligenceContext(context);

  const recordEvaluation = async (payload: Record<string, unknown>) => {
    const res = await emitRestaurantEvent(sb, userId, {
      type: "restaurant.intelligence.menu.evaluated",
      tenantId: input.tenantId,
      entityType: "restaurant_menu_intelligence_evaluation",
      entityId: input.tenantId,
      source: "restaurant-os",
      payload,
    });
    return res.delivered;
  };

  if (!context.hasData) {
    const evaluationRecorded = await recordEvaluation({
      question: input.question,
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      windowDays: input.windowDays,
      outcome: "insufficient_data",
      validationStatus: "skipped",
    });
    return {
      ok: false,
      reason: "insufficient_data",
      detail:
        "No sales recorded in this window — insufficient evidence to make a reliable recommendation.",
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      evaluationRecorded,
    };
  }

  const system = buildSystemPrompt(context);
  const call = await callReasoningProvider(input.provider, {
    system,
    user: input.question,
    jsonMode: true,
  });

  if (call.unavailable) {
    const evaluationRecorded = await recordEvaluation({
      question: input.question,
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      windowDays: input.windowDays,
      outcome: "provider_unavailable",
      validationStatus: "skipped",
      detail: call.reason,
    });
    return {
      ok: false,
      reason: "provider_unavailable",
      detail: call.reason,
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      evaluationRecorded,
    };
  }

  const parsed = parseAiJson<unknown>(call.content);
  const validated = parsed == null ? null : menuReasoningResultSchema.safeParse(parsed);

  if (!validated || !validated.success) {
    const evaluationRecorded = await recordEvaluation({
      question: input.question,
      provider: input.provider,
      model: call.model,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      windowDays: input.windowDays,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      outcome: "invalid_response",
      validationStatus: "schema_invalid",
    });
    return {
      ok: false,
      reason: "invalid_response",
      detail: "The model's response did not match the required structured-output schema.",
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      evaluationRecorded,
    };
  }

  const grounding = validateGrounding(validated.data, context);
  if (!grounding.ok) {
    const evaluationRecorded = await recordEvaluation({
      question: input.question,
      provider: input.provider,
      model: call.model,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      windowDays: input.windowDays,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      outcome: "fabricated_evidence",
      validationStatus: "grounding_failed",
      detail: grounding.detail,
    });
    return {
      ok: false,
      reason: "fabricated_evidence",
      detail: grounding.detail,
      provider: input.provider,
      promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
      contextHash,
      evaluationRecorded,
    };
  }

  const evaluationRecorded = await recordEvaluation({
    question: input.question,
    provider: input.provider,
    model: call.model,
    promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
    contextHash,
    windowDays: input.windowDays,
    latencyMs: call.latencyMs,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    outcome: "valid",
    validationStatus: "valid",
    result: validated.data,
  });

  return {
    ok: true,
    result: validated.data,
    provider: input.provider,
    model: call.model,
    latencyMs: call.latencyMs,
    promptVersion: MENU_INTELLIGENCE_PROMPT_VERSION,
    contextHash,
    evaluationRecorded,
  };
}
