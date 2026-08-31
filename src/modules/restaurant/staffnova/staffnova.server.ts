/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows / AI gateway payloads are untyped at this boundary. */
/**
 * Staff Ask NOVA — Pre-I10.
 *
 * A bounded, authenticated conversational surface for restaurant staff,
 * deliberately built as a THIN layer over infrastructure that already
 * exists, per the Pre-I10 audit:
 *
 *  - Transport: the same generic AI gateway guest Ask NOVA and
 *    decision.server.ts#narrate() already call
 *    (src/lib/ai-gateway.server.ts) — unmodified, imported directly.
 *  - Grounding: the existing, unmodified deterministic intelligence engines
 *    (menu/inventory/kitchen/purchasing), the existing POS floor stats
 *    (today's revenue/covers), and the existing restaurant decision board
 *    (live findings + persisted decisions). Nothing here recomputes what
 *    those already compute; this file only projects their output into a
 *    compact, bounded JSON context for the model to read from.
 *  - Security: the existing tenant-scoped capability system
 *    (assertCapability, "intelligence.read" — the same capability
 *    runRestaurantDecisionPass already requires). No new RBAC model.
 *
 * Anti-fabrication design (see the Pre-I10 report for the full rationale):
 * unlike guest Ask NOVA's item-recommendation flow, a staff answer is free
 * text, not a small set of catalogue ids — there is no finite id-whitelist
 * to re-validate the model's output against post-hoc. The grounding
 * discipline here is therefore the same one decision.server.ts#narrate()
 * already establishes as this codebase's precedent for staff-facing AI
 * text: the model is NEVER given anything but real, freshly computed
 * numbers, and the system prompt explicitly instructs it to answer only
 * from that data and to say so plainly when a question falls outside it —
 * matched by an equivalent instruction in every staff-facing question this
 * sprint's spec enumerates as an explicit "I don't have that data" example.
 *
 * No autonomous action: this module only ever reads. It never writes to
 * intelligence_decisions, restaurant operational tables, or anything else.
 *
 * I11 "NOVA UNDERSTAND": a command-shaped staff message ("Prepare a stock
 * movement for 3kg beef...") is intercepted before the free-text AI call
 * below and answered with a structured NovaIntentContract instead (see
 * understand/understand.server.ts) — a plain question still goes through
 * the unmodified grounded Q&A flow this file already had. Classification
 * is a pure, cheap, DB-free check, so every staff message pays for it.
 */
import { assertCapability } from "../core/access.server";
import { classifyInstruction } from "../understand/classify";
import type { NovaIntentContract } from "../understand/intent.contracts";
import type { StaffNovaAskInput } from "./staffnova.contracts";

type Sb = any;

const WINDOW_DAYS = 30;
/** Mirrors guest Ask NOVA's MAX_CATALOG_ITEMS_FOR_AI discipline — bound every list handed to the model so the prompt stays small and cheap regardless of tenant size. */
const MAX_ROWS_PER_LIST = 8;

export interface StaffNovaAnswer {
  answer: string;
  /** True only when the AI gateway itself could not be reached/errored — the grounding data was still gathered correctly; the caller degrades to a plain apology rather than fabricating an answer. */
  degraded: boolean;
  generatedAt: string;
  /** I11: set only when the message was classified as an operational instruction rather than a plain question — the structured understanding, never an executed action. See understand/understand.server.ts. */
  understanding?: NovaIntentContract;
}

/** Best-effort loader: a single engine's failure never takes down the whole answer — it's simply marked unavailable in the context, and the system prompt tells the model to say so rather than guess. */
async function tryLoad<T>(
  label: string,
  load: () => Promise<T>,
): Promise<T | { unavailable: true; reason: string }> {
  try {
    return await load();
  } catch (err) {
    return { unavailable: true, reason: (err as Error)?.message ?? `${label} unavailable` };
  }
}

function take<T>(rows: T[] | undefined, n = MAX_ROWS_PER_LIST): T[] {
  return (rows ?? []).slice(0, n);
}

/**
 * Gathers the bounded, compact grounding context handed to the model.
 * Every field traces to an existing, unmodified read function — see the
 * file doc comment. Nothing here is invented; anything a given tenant
 * genuinely has none of (e.g. no purchase suggestions this window) simply
 * renders as an empty list, which the model is instructed to treat as "none
 * currently", not silently skip.
 */
async function buildStaffNovaContext(sb: Sb, userId: string, tenantId: string) {
  const [sales, menu, inventory, kitchen, purchasing, board] = await Promise.all([
    tryLoad("sales", async () => {
      const mod = await import("../sales/pos.server");
      const result = await mod.posBoard(sb, userId, { tenantId });
      return result.stats;
    }),
    tryLoad("menu", async () => {
      const mod = await import("../intelligence/menu.server");
      const m = await mod.getMenuIntelligence(sb, userId, { tenantId, windowDays: WINDOW_DAYS });
      return {
        currency: m.currency,
        windowDays: m.windowDays,
        totals: m.totals,
        profitDrivers: take(m.profitDrivers).map((i) => ({
          name: i.name,
          revenue: i.revenue,
          marginPercent: i.marginPercent,
        })),
        marginLosers: take(m.marginLosers).map((i) => ({
          name: i.name,
          marginPercent: i.marginPercent,
          foodCostPercent: i.foodCostPercent,
        })),
        declining: take(m.declining).map((i) => ({
          name: i.name,
          trendPercent: i.trendPercent,
          quantitySold: i.quantitySold,
        })),
        needsCostReview: take(m.costReview).map((i) => ({
          name: i.name,
          reason: i.costReviewReason,
        })),
        insights: take(m.insights, 6),
      };
    }),
    tryLoad("inventory", async () => {
      const mod = await import("../intelligence/inventory.server");
      const i = await mod.getInventoryIntelligence(sb, userId, {
        tenantId,
        windowDays: WINDOW_DAYS,
      });
      return {
        currency: i.currency,
        atRisk: take(i.atRisk).map((r) => ({
          name: r.name,
          currentQuantity: r.currentQuantity,
          daysOfCover: r.daysOfCover,
          belowReorder: r.belowReorder,
        })),
        wastage: i.wastage,
        priceThreats: take(i.priceThreats, 5),
        insights: take(i.insights, 6),
      };
    }),
    tryLoad("kitchen", async () => {
      const mod = await import("../intelligence/kitchen.server");
      const k = await mod.getKitchenIntelligence(sb, userId, { tenantId, windowDays: WINDOW_DAYS });
      return {
        averagePrepMinutes: k.averagePrepMinutes,
        previousAveragePrepMinutes: k.previousAveragePrepMinutes,
        trendPercent: k.trendPercent,
        stations: take(k.stations).map((s) => ({
          name: s.name,
          averagePrepMinutes: s.averagePrepMinutes,
          targetMinutes: s.targetMinutes,
          overTarget: s.overTarget,
          delayedPercent: s.delayedPercent,
        })),
        insights: take(k.insights, 6),
      };
    }),
    tryLoad("purchasing", async () => {
      const mod = await import("../intelligence/purchasing.server");
      const p = await mod.getPurchasingIntelligence(sb, userId, {
        tenantId,
        windowDays: WINDOW_DAYS,
      });
      return {
        currency: p.currency,
        suggestions: take(p.suggestions).map((s) => ({
          name: s.name,
          recommendedQuantity: s.recommendedQuantity,
          estimatedCost: s.estimatedCost,
          supplierName: s.supplierName,
        })),
        suppliers: take(p.suppliers, 5).map((s) => ({
          name: s.name,
          onTimePercent: s.onTimePercent,
          score: s.score,
        })),
        expectedMonthlySpend: p.expectedMonthlySpend,
        spendChangePercent: p.spendChangePercent,
        insights: take(p.insights, 6),
      };
    }),
    tryLoad("decisions", async () => {
      const mod = await import("../decisions/decisions.server");
      const b = await mod.getRestaurantDecisionBoard(sb, userId, {
        tenantId,
        windowDays: WINDOW_DAYS,
        includeStored: true,
      });
      return {
        findings: take(b.findings, 8).map((f) => ({
          severity: f.severity,
          subject: f.subject,
          headline: f.headline,
          detail: f.detail,
        })),
        decisions: take(b.stored, 8).map((d) => ({
          title: d.title,
          status: d.status,
          riskLevel: d.riskLevel,
          trigger: d.trigger,
        })),
      };
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    sales,
    menu,
    inventory,
    kitchen,
    purchasing,
    findings: (board as any)?.unavailable ? board : (board as any).findings,
    decisions: (board as any)?.unavailable ? board : (board as any).decisions,
  };
}

const STAFF_NOVA_SYSTEM_PROMPT = `You are NOVA, an operations assistant for restaurant and bar staff (managers, chefs, kitchen and inventory leads). You are answering a signed-in staff member of ONE specific restaurant, not a guest.

You will be given CONTEXT as JSON: today's sales snapshot, menu performance, inventory/stock, kitchen performance, purchasing/replenishment, current intelligence findings, and current decisions — all already computed by this restaurant's own systems for the correct restaurant.

Hard rules:
- Answer ONLY using facts present in CONTEXT. Never invent, estimate, or guess a number, name, or fact that is not in CONTEXT.
- If a field in CONTEXT is marked unavailable, or the question needs data CONTEXT does not contain (for example staff-hours, scheduling, or anything outside sales/menu/inventory/kitchen/purchasing/findings/decisions), say so plainly instead of guessing. Example: "I don't have staff-hours data, so I can't reliably calculate required staffing." This is the correct, expected answer in that case — not a failure.
- You are informational only. You never take, schedule, or promise to take any action (no orders, no approvals, no changes). If asked to act, explain that this is outside what you can do here and point to the relevant page (Decisions, Intelligence, Inventory, Purchasing) instead.
- Keep answers short, concrete, and useful to a busy manager: lead with the number or fact, then one or two sentences of context. Plain English, no bullet-point walls, no markdown headers.`;

/**
 * Answers one staff question, grounded in this tenant's own already-computed
 * data. Stateless: history is client-held context only, nothing is
 * persisted here, matching guest Ask NOVA's own "no conversation storage"
 * design (see the Pre-I10 audit).
 */
export async function askStaffNova(
  sb: Sb,
  userId: string,
  input: StaffNovaAskInput,
): Promise<StaffNovaAnswer> {
  // The one authorization gate: reused unmodified, keyed off the verified
  // JWT userId — never off anything the client asserts. A guest has no
  // session that could ever satisfy this; there is no code path from the
  // guest surface into this function.
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const generatedAt = new Date().toISOString();

  // I11: a command-shaped message never reaches the free-text AI call
  // below — it's understood structurally instead, deterministically, with
  // zero operational mutation. A plain question (the classifier's default)
  // falls straight through to the existing flow, unchanged.
  const quickClassification = classifyInstruction(input.message);
  if (quickClassification.intent !== "information_query") {
    try {
      const { understandNovaInstruction } = await import("../understand/understand.server");
      const { contract, summary } = await understandNovaInstruction(sb, userId, {
        tenantId: input.tenantId,
        message: input.message,
      });
      return { answer: summary, degraded: false, generatedAt, understanding: contract };
    } catch {
      // Same "fail closed to a plain apology, never fabricate" discipline
      // as the free-text AI path below — a lookup failure here must not
      // crash the whole Ask NOVA panel.
      return {
        answer:
          "I'm unable to work out the details of that request right now. Please try again in a moment, or phrase it as a question and I'll answer from what I know.",
        degraded: true,
        generatedAt,
      };
    }
  }

  const context = await buildStaffNovaContext(sb, userId, input.tenantId);

  try {
    const { callAiGateway } = await import("@/lib/ai-gateway.server");
    const { content } = await callAiGateway({
      system: STAFF_NOVA_SYSTEM_PROMPT,
      user: JSON.stringify({
        context,
        history: input.history,
        question: input.message,
      }),
    });
    const answer = content.trim();
    if (!answer) throw new Error("Empty response from AI gateway");
    return { answer, degraded: false, generatedAt };
  } catch {
    // Never fabricate on an AI failure — degrade to an honest, static
    // message, same "fail closed to a plain apology" behavior guest Ask
    // NOVA's defaultAiCaller degrade path already uses.
    return {
      answer:
        "I'm unable to reach the NOVA assistant right now. Please try again in a moment, or check the Intelligence and Decisions pages directly for the latest data.",
      degraded: true,
      generatedAt,
    };
  }
}
