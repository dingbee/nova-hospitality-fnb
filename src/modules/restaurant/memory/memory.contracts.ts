/**
 * I15 "NOVA MEMORY & OPERATING AGENT" — contracts.
 *
 * Restaurant staff memory reuses the intelligence_memory / intelligence_feedback
 * TABLES the Intelligence Core's memory.server.ts already writes to (see
 * migrations/0024_intelligence_memory.sql) — but never that module's own
 * remember()/recall()/assertIntelRead(), which is a platform-wide permission
 * with no restaurant-tenant-membership check and a scope vocabulary
 * (INTEL_MEMORY_SCOPES) with no personal-vs-restaurant distinction. This
 * module is the restaurant-RBAC-aware, tenant/user-scoped equivalent —
 * memory.server.ts reads/writes the same tables directly.
 *
 * Two scopes only, deliberately narrower than the platform vocabulary:
 *  - "tenant": a restaurant-level operating preference/fact any staff member
 *    of that tenant can read; only a managerial role can write or forget one.
 *  - "user": one staff member's own personal preference — only that member
 *    can ever read, write, forget, or correct it. Never another staff
 *    member, even a manager (spec section 40 — the privacy boundary).
 */
import { z } from "zod";

export const RESTAURANT_MEMORY_SCOPES = ["tenant", "user"] as const;
export type RestaurantMemoryScope = (typeof RESTAURANT_MEMORY_SCOPES)[number];

/**
 * Kept deliberately small and non-interchangeable (spec section 3):
 *  - preference: a stated or inferred convenience (a UI/format/workflow
 *    default). Never authority — see validateAiProposedMemory.
 *  - operational_note: a discussed, useful piece of operational context
 *    ("we're short-staffed Fridays") — a pointer to context, never a
 *    duplicate of a live number (spec section 51).
 *  - verified_outcome: the result of an I13-verified execution. Written
 *    only by rememberVerifiedOutcome() in memory.server.ts, never directly
 *    by a caller (see rememberRestaurantMemorySchema below).
 *  - interaction: a deliberately selected, consequential exchange worth
 *    recalling later — never an automatic transcript of every message.
 */
export const RESTAURANT_MEMORY_TYPES = [
  "preference",
  "operational_note",
  "verified_outcome",
  "interaction",
] as const;
export type RestaurantMemoryType = (typeof RESTAURANT_MEMORY_TYPES)[number];

/** Provenance a caller may directly assert. "verified_outcome" is deliberately excluded from caller-writable schemas below — only rememberVerifiedOutcome() may write it, and only from I13's own post-verification path (spec section 49: success memory only stored when independently verified, never from an AI response alone). */
export const RESTAURANT_MEMORY_CALLER_SOURCES = ["user_stated", "inferred"] as const;
export type RestaurantMemoryCallerSource = (typeof RESTAURANT_MEMORY_CALLER_SOURCES)[number];

export const RESTAURANT_MEMORY_STATUSES = [
  "new",
  "reviewing",
  "accepted",
  "dismissed",
  "expired",
  "superseded",
] as const;
export type RestaurantMemoryStatus = (typeof RESTAURANT_MEMORY_STATUSES)[number];

export interface RestaurantMemory {
  id: string;
  scope: RestaurantMemoryScope;
  userId: string | null;
  memoryType: RestaurantMemoryType;
  memoryKey: string;
  memoryValue: string;
  memoryTier: "observed" | "learned" | "strategic";
  confidence: number;
  source: string;
  status: RestaurantMemoryStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const memoryKeySchema = z.string().trim().min(1).max(200);
const memoryValueSchema = z.string().trim().min(1).max(2000);

const CALLER_WRITABLE_TYPES = z.enum(RESTAURANT_MEMORY_TYPES).exclude(["verified_outcome"]);

/**
 * Explicit vs inferred discipline (spec section 5): "inferred" memory must
 * never silently become a permanent, unqualified preference — it must carry
 * an explicit confidence and expiry. "user_stated" is always full-confidence
 * and, being an explicit instruction from the person it's about, never
 * expires on its own (a person can still forget/correct it explicitly).
 */
export const rememberRestaurantMemorySchema = z
  .object({
    tenantId: z.string().uuid(),
    scope: z.enum(RESTAURANT_MEMORY_SCOPES),
    memoryType: CALLER_WRITABLE_TYPES,
    memoryKey: memoryKeySchema,
    memoryValue: memoryValueSchema,
    source: z.enum(RESTAURANT_MEMORY_CALLER_SOURCES),
    confidence: z.number().min(0).max(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.source === "inferred" && !val.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An inferred memory must carry an expiry — it can never become a permanent preference silently.",
        path: ["expiresAt"],
      });
    }
  });
export type RememberRestaurantMemoryInput = z.infer<typeof rememberRestaurantMemorySchema>;

export const recallRestaurantMemorySchema = z.object({
  tenantId: z.string().uuid(),
  scope: z.enum(RESTAURANT_MEMORY_SCOPES).optional(),
  memoryType: z.enum(RESTAURANT_MEMORY_TYPES).optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type RecallRestaurantMemoryInput = z.infer<typeof recallRestaurantMemorySchema>;

export const forgetRestaurantMemorySchema = z.object({
  tenantId: z.string().uuid(),
  memoryId: z.string().uuid(),
});
export type ForgetRestaurantMemoryInput = z.infer<typeof forgetRestaurantMemorySchema>;

/** Corrects the existing row's value in place — never appends a second, contradicting row (spec section 42/54: "old memory becomes inactive/updated, not endlessly appended contradictions"). Execution paths must still always re-validate current entities regardless of what a corrected memory says (I13 never trusts memory for authority/quantity/price). */
export const correctRestaurantMemorySchema = z.object({
  tenantId: z.string().uuid(),
  memoryId: z.string().uuid(),
  memoryValue: memoryValueSchema,
});
export type CorrectRestaurantMemoryInput = z.infer<typeof correctRestaurantMemorySchema>;

export const submitRestaurantMemoryFeedbackSchema = z.object({
  tenantId: z.string().uuid(),
  subjectType: z.enum(["insight", "recommendation", "prediction", "action", "memory"]),
  subjectId: z.string().uuid(),
  useful: z.boolean().optional(),
  comment: z.string().trim().max(1000).optional(),
});
export type SubmitRestaurantMemoryFeedbackInput = z.infer<
  typeof submitRestaurantMemoryFeedbackSchema
>;

/**
 * Strict allowlist for an AI-PROPOSED memory candidate (spec section 36):
 * before Staff Ask NOVA ever shows a "Remember this?" confirmation, the
 * model's raw proposal is validated against this — never written directly
 * (spec section 66: "AI never directly writes arbitrary memories"; the
 * confirmation click is what actually calls rememberRestaurantMemory).
 * Anything that doesn't parse, or whose text reads like a claim of
 * authority, a permission grant, or a secret, is rejected outright.
 */
const AUTHORITY_OR_SECRET_PATTERN =
  /\b(approv\w*|authoriz\w*|permission\w*|bypass\w*|override\w*|admin\w*|can\s+approve|ignore\s+(the\s+)?(rule|polic|instruction|permission|approval)\w*|password|api[\s-]?key|token|secret|credential|payment\s*card|cvv)\b/i;

export const aiProposedMemorySchema = z.object({
  scope: z.enum(RESTAURANT_MEMORY_SCOPES),
  memoryType: CALLER_WRITABLE_TYPES,
  memoryKey: memoryKeySchema,
  memoryValue: memoryValueSchema,
  confidence: z.number().min(0).max(1),
});
export type AiProposedMemory = z.infer<typeof aiProposedMemorySchema>;

export interface AiProposedMemoryValidation {
  ok: boolean;
  reason?: string;
  memory?: AiProposedMemory;
}

/**
 * Pure, deterministic — no AI call, no DB read. Rejects: anything failing
 * the strict schema (unknown scope/type/extra fields), and anything whose
 * key or value text reads like an authority/permission claim or a secret —
 * a candidate saying "user can approve POs" or containing a password must
 * never reach the database (spec section 61's "remember-that-I-can-
 * approve-POs" adversarial case). This is a text-pattern floor, not a
 * substitute for the RBAC/RLS boundary — memory written here still can
 * never grant authority even if a malicious phrase slipped past it, since
 * nothing in this codebase ever reads intelligence_memory to decide
 * permissions (see memory.server.ts's file doc comment).
 */
export function validateAiProposedMemory(candidate: unknown): AiProposedMemoryValidation {
  const parsed = aiProposedMemorySchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: "Not a recognized memory shape." };
  }
  const text = `${parsed.data.memoryKey} ${parsed.data.memoryValue}`;
  if (AUTHORITY_OR_SECRET_PATTERN.test(text)) {
    return {
      ok: false,
      reason: "Refused: reads like an authority, permission, or secret claim, not a preference.",
    };
  }
  return { ok: true, memory: parsed.data };
}

/**
 * Spec section 8: "low-risk UI/format preferences may auto-store" without
 * an explicit confirm click — but "authority/operational memories require
 * stronger governance." This is the deterministic line between the two:
 * only a SHORT, USER-OWN, explicitly-stated, plain "preference" already
 * validated by validateAiProposedMemory qualifies. Anything tenant-scoped,
 * anything not already-validated, anything of type operational_note/
 * interaction, or anything long enough to plausibly encode more than a
 * simple UI/format convenience must still go through an explicit human
 * confirmation before rememberRestaurantMemory is ever called.
 */
export function isLowRiskAutoStoreCandidate(memory: AiProposedMemory): boolean {
  return (
    memory.scope === "user" && memory.memoryType === "preference" && memory.memoryValue.length <= 80
  );
}
