/**
 * I11 "NOVA UNDERSTAND" — the canonical NOVA Intent Contract.
 *
 * This is the one new thing this sprint adds: nothing in the existing
 * codebase classifies a natural-language operational instruction into a
 * structured, machine-consumable shape (see the I11 architectural verdict
 * for the full audit this is built on). This contract is understanding
 * only — nothing that reads it may treat it as authority to mutate
 * operational state. A later sprint (I12) is the one that turns a
 * validated contract into an actual prepared document.
 *
 * Every enum here is grounded in restaurant modules that already exist
 * (inventory, procurement, menu, kitchen, requisitions, purchasing) — not
 * invented ahead of what the app actually does.
 */
import { z } from "zod";

/** What kind of utterance this is — deterministic enough for downstream governance to gate on (see NOVA_UNDERSTAND spec section 4). */
export const NOVA_INTENT_TYPES = [
  "information_query",
  "operational_command",
  "approval_request",
  "planning_request",
] as const;
export type NovaIntentType = (typeof NOVA_INTENT_TYPES)[number];

/** Subject-matter domain, reusing this app's own module vocabulary. */
export const NOVA_DOMAINS = [
  "inventory",
  "stock_movement",
  "procurement",
  "menu",
  "pricing",
  "kitchen",
  "sales",
  "supplier",
  "reporting",
  "intelligence",
  "general",
] as const;
export type NovaDomain = (typeof NOVA_DOMAINS)[number];

/**
 * Operational actions this app already implements somewhere (see the
 * architectural verdict, point 5). I11 only ever *names* one of these —
 * it never calls the function it refers to. Naming an action here grants
 * no operational authority by itself.
 */
export const NOVA_ACTIONS = [
  "prepare_purchase_order",
  "prepare_stock_movement",
  "prepare_requisition",
  "query_inventory",
  "query_sales",
  "query_menu",
  "query_kitchen",
  "approve_purchase_order",
  "submit_purchase_order",
  "execute_stock_movement",
  "unknown",
] as const;
export type NovaAction = (typeof NOVA_ACTIONS)[number];

/**
 * What the user asked NOVA to do with this understanding — recorded
 * structurally, never honored. I11 always understands only; a later sprint
 * decides whether/how to act on a "prepare"/"execute"/"approve"/"submit"
 * request.
 */
export const NOVA_REQUESTED_EXECUTIONS = [
  "understand_only",
  "prepare",
  "execute",
  "approve",
  "submit",
] as const;
export type NovaRequestedExecution = (typeof NOVA_REQUESTED_EXECUTIONS)[number];

/**
 * Entity-resolution outcome. Reuses the same tier semantics Import
 * Studio's matching engine already established (catalog/matching.ts +
 * import/stage.ts's classify()): EXACT/HIGH resolve to a single real row;
 * AMBIGUOUS means multiple candidates are plausibly tied — never guessed
 * between; UNRESOLVED means nothing matched confidently enough.
 */
export const NOVA_ENTITY_MATCH_STATUSES = ["exact", "high", "ambiguous", "unresolved"] as const;
export type NovaEntityMatchStatus = (typeof NOVA_ENTITY_MATCH_STATUSES)[number];

export const NOVA_ENTITY_DOMAINS = ["inventory_item", "menu_item", "supplier", "location"] as const;
export type NovaEntityDomain = (typeof NOVA_ENTITY_DOMAINS)[number];

export const novaCandidateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    score: z.number(),
  })
  .strict();
export type NovaCandidate = z.infer<typeof novaCandidateSchema>;

export const novaQuantityMentionSchema = z
  .object({
    raw: z.string(),
    quantity: z.number(),
    unitText: z.string(),
    /** Only set when unitText matched a real restaurant_inventory_units row by exact code/name — never inferred or converted. */
    resolvedUnitId: z.string().nullable(),
  })
  .strict();
export type NovaQuantityMention = z.infer<typeof novaQuantityMentionSchema>;

/**
 * One resolved (or attempted) mention of a real restaurant entity —
 * "beef", "Coca-Cola", "our preferred supplier", "the kitchen". Never
 * invented: `resolvedId`/`resolvedName` are only ever populated from an
 * actual server-side row via the existing catalog matching engine.
 */
export const novaEntityMentionSchema = z
  .object({
    raw: z.string(),
    entityDomain: z.enum(NOVA_ENTITY_DOMAINS),
    status: z.enum(NOVA_ENTITY_MATCH_STATUSES),
    resolvedId: z.string().nullable(),
    resolvedName: z.string().nullable(),
    candidates: z.array(novaCandidateSchema).max(5),
    /** Set only when this mention was paired with a stated quantity in the same command line (e.g. "3kg beef"). */
    quantity: novaQuantityMentionSchema.nullable(),
  })
  .strict();
export type NovaEntityMention = z.infer<typeof novaEntityMentionSchema>;

export const NOVA_SUPPLIER_REFERENCE_KINDS = [
  "named",
  "preferred",
  "cheapest",
  "unspecified",
] as const;
export type NovaSupplierReferenceKind = (typeof NOVA_SUPPLIER_REFERENCE_KINDS)[number];

/**
 * "cheapest supplier" is deliberately never resolved to an id here —
 * ranking suppliers by price is the purchasing engine's own logic
 * (intelligence/purchasing.server.ts), and I11 does not duplicate it. It
 * is captured as a structural criterion with status "deferred" so I12 can
 * hand it to that engine later.
 */
export const novaSupplierReferenceSchema = z
  .object({
    raw: z.string(),
    kind: z.enum(NOVA_SUPPLIER_REFERENCE_KINDS),
    status: z.enum([...NOVA_ENTITY_MATCH_STATUSES, "deferred"]),
    resolvedId: z.string().nullable(),
    resolvedName: z.string().nullable(),
    candidates: z.array(novaCandidateSchema).max(5),
  })
  .strict();
export type NovaSupplierReference = z.infer<typeof novaSupplierReferenceSchema>;

export const novaLocationReferenceSchema = z
  .object({
    raw: z.string(),
    status: z.enum(NOVA_ENTITY_MATCH_STATUSES),
    resolvedId: z.string().nullable(),
    resolvedName: z.string().nullable(),
    candidates: z.array(novaCandidateSchema).max(5),
  })
  .strict();
export type NovaLocationReference = z.infer<typeof novaLocationReferenceSchema>;

export const NOVA_TEMPORAL_KINDS = [
  "today",
  "tomorrow",
  "this_evening",
  "next_week",
  "unspecified_relative",
] as const;
export type NovaTemporalKind = (typeof NOVA_TEMPORAL_KINDS)[number];

export const NOVA_SERVICE_PERIODS = ["breakfast", "lunch", "dinner", "unspecified"] as const;
export type NovaServicePeriod = (typeof NOVA_SERVICE_PERIODS)[number];

/**
 * A parsed temporal reference. Never used to compute a forecast/quantity —
 * that belongs to a later planning layer (spec section 14); this only
 * records what the user said.
 */
export const novaTemporalReferenceSchema = z
  .object({
    raw: z.string(),
    kind: z.enum(NOVA_TEMPORAL_KINDS),
    servicePeriod: z.enum(NOVA_SERVICE_PERIODS).nullable(),
  })
  .strict();
export type NovaTemporalReference = z.infer<typeof novaTemporalReferenceSchema>;

export const novaAmbiguitySchema = z
  .object({
    /** Which part of the contract is ambiguous, e.g. "entities[0]", "locations.destination", "supplier". */
    field: z.string(),
    reason: z.string(),
    candidates: z.array(novaCandidateSchema).max(5),
  })
  .strict();
export type NovaAmbiguity = z.infer<typeof novaAmbiguitySchema>;

/**
 * The canonical NOVA Intent Contract. `.strict()` so an unexpected field
 * (from a future careless edit) fails fast rather than silently passing
 * through to a consumer.
 */
export const novaIntentContractSchema = z
  .object({
    intent: z.enum(NOVA_INTENT_TYPES),
    domain: z.enum(NOVA_DOMAINS),
    action: z.enum(NOVA_ACTIONS),
    entities: z.array(novaEntityMentionSchema).max(20),
    locations: z
      .object({
        source: novaLocationReferenceSchema.nullable(),
        destination: novaLocationReferenceSchema.nullable(),
      })
      .strict(),
    supplier: novaSupplierReferenceSchema.nullable(),
    temporal: novaTemporalReferenceSchema.nullable(),
    /** Verbatim qualifier/negation clauses ("except the beer", "only for tomorrow") — never dropped, even when not further interpreted. */
    constraints: z.array(z.string()).max(20),
    requestedExecution: z.enum(NOVA_REQUESTED_EXECUTIONS),
    /** Overall classification confidence — never a substitute for entity-level match status; an operational decision must never be made on this number alone. */
    confidence: z.number().min(0).max(1),
    missingInformation: z.array(z.string()).max(20),
    ambiguities: z.array(novaAmbiguitySchema).max(20),
  })
  .strict();
export type NovaIntentContract = z.infer<typeof novaIntentContractSchema>;

export const understandNovaInstructionSchema = z.object({
  tenantId: z.string().uuid(),
  message: z.string().min(1).max(2000),
});
export type UnderstandNovaInstructionInput = z.infer<typeof understandNovaInstructionSchema>;
