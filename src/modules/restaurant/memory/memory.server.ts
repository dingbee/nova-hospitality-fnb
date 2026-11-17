/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I15 "NOVA MEMORY & OPERATING AGENT" — orchestration.
 *
 * Reads/writes the SAME intelligence_memory / intelligence_feedback tables
 * the Intelligence Core's memory.server.ts uses (see
 * standalone/db/migrations/0024_intelligence_memory.sql) but never calls
 * that module's remember()/recall()/assertIntelRead() — those are gated by
 * a platform-wide permission with zero restaurant-tenant-membership check,
 * and its scope vocabulary has no personal-vs-restaurant distinction. This
 * module is the restaurant module's own RBAC-aware equivalent, exactly
 * mirroring the migration's RLS policies at the TypeScript layer (RLS
 * remains the real enforcement point; these checks fail fast with a
 * readable error before ever attempting a write).
 *
 * MEMORY AUTHORITY LIMIT (spec section 6 — read this before extending this
 * file): nothing here, and nothing that reads its output, may ever be
 * treated as authorization, price, quantity, supplier, inventory balance,
 * approval, tenant, or workflow state. Every execution path (I13's
 * act.server.ts) re-derives all of that fresh, every time, regardless of
 * what any memory row says. A stored memory is DATA presented to a human
 * or an AI explanation layer — never an instruction, never a source of
 * truth. See validateAiProposedMemory in memory.contracts.ts for the
 * matching defense on the write side.
 */
import { assertCapability, assertTenantRead, rolesInTenant } from "../core/access.server";
import type {
  CorrectRestaurantMemoryInput,
  ForgetRestaurantMemoryInput,
  RecallRestaurantMemoryInput,
  RememberRestaurantMemoryInput,
  RestaurantMemory,
  SubmitRestaurantMemoryFeedbackInput,
} from "./memory.contracts";

type Sb = any;

/**
 * Mirrors the live DB's restaurant_can_manage_intelligence(_tenant_id)
 * SQL function EXACTLY (queried via pg_get_functiondef during the I15
 * audit) — the same role set the migration's RLS policies gate
 * tenant-scope (user_id null) memory writes/updates/deletes with.
 * Deliberately NOT one of permissions.ts's existing capabilities: the
 * closest one ("intelligence.read") additionally includes bartender, which
 * would let a bartender pass this TS-layer check only to have the identical
 * write rejected by RLS — a confusing failure, not a security hole, but
 * worth avoiding by mirroring the DB function precisely instead of
 * approximating it.
 */
const MANAGE_TENANT_MEMORY_ROLES = new Set([
  "owner",
  "general_manager",
  "restaurant_manager",
  "chef",
  "kitchen_manager",
  "inventory_manager",
  "purchasing_officer",
  "accountant",
]);

async function assertCanManageTenantMemory(sb: Sb, userId: string, tenantId: string) {
  const roles = await rolesInTenant(sb, userId, tenantId);
  if (roles.some((r) => MANAGE_TENANT_MEMORY_ROLES.has(r))) return;
  // A platform admin (owner/admin/manager platform role) still passes via
  // assertCapability elsewhere in this codebase; mirror that fallback here
  // too rather than locking platform admins out of tenant memory hygiene.
  await assertCapability(sb, userId, tenantId, "intelligence.read");
  const stillNotManagerial = !roles.some((r) => MANAGE_TENANT_MEMORY_ROLES.has(r));
  if (stillNotManagerial) {
    throw new Error(
      "Forbidden — managing restaurant-level memory requires a managerial role for this tenant.",
    );
  }
}

function toRestaurantMemory(row: any): RestaurantMemory {
  return {
    id: row.id,
    scope: row.scope,
    userId: row.user_id ?? null,
    memoryType: row.memory_type,
    memoryKey: row.memory_key,
    memoryValue: row.memory_value,
    memoryTier: row.memory_tier,
    confidence: Number(row.confidence),
    source: row.source,
    status: row.status,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * memory_tier is deliberately computed here, never caller-supplied — an
 * AI-proposed or staff-typed memory can never claim "strategic" tier for
 * itself. An explicit, user-stated preference is the durable, policy-like
 * case (strategic); an explicit but non-preference statement (a discussed
 * operational note, or a selected interaction) is a plain observed fact;
 * anything inferred is a learned pattern, never presented as stated.
 */
function tierFor(input: Pick<RememberRestaurantMemoryInput, "source" | "memoryType">) {
  if (input.source === "inferred") return "learned" as const;
  if (input.memoryType === "preference") return "strategic" as const;
  return "observed" as const;
}

/**
 * Explicit-vs-inferred confidence discipline (spec section 5): an explicit
 * statement is full confidence by definition — the person said it. An
 * inferred pattern is never presented at full confidence, and the caller's
 * own confidence is clamped below 1 so it can never masquerade as explicit.
 */
function confidenceFor(input: RememberRestaurantMemoryInput): number {
  if (input.source === "user_stated") return 1;
  const raw = input.confidence ?? 0.6;
  return Math.min(raw, 0.95);
}

/**
 * Stores an explicit staff statement or a human-CONFIRMED inferred
 * candidate. By the time this is ever called, confirmation has already
 * happened — either the staff member typed the preference directly
 * (source "user_stated"), or they clicked "Remember" on an AI-proposed
 * candidate that first passed validateAiProposedMemory (source
 * "inferred") — so the resulting row is written as "accepted" immediately;
 * there is no separate silent-write path (spec section 66: AI never
 * directly writes arbitrary memories).
 *
 * Reinforces an existing row in place, keyed by (tenant, scope, user,
 * memory_key) — a fresh explicit statement always wins over whatever was
 * there before (spec section 41's conflict precedence: "new explicit
 * preference" outranks an older observation), never appended as a second,
 * contradicting row.
 */
export async function rememberRestaurantMemory(
  sb: Sb,
  userId: string,
  input: RememberRestaurantMemoryInput,
): Promise<{ id: string; updated: boolean }> {
  if (input.scope === "user") {
    await assertTenantRead(sb, userId, input.tenantId);
  } else {
    await assertCanManageTenantMemory(sb, userId, input.tenantId);
  }

  const now = new Date().toISOString();
  const ownerUserId = input.scope === "user" ? userId : null;
  const row = {
    scope: input.scope,
    scope_id: null,
    module: "restaurant",
    tenant_id: input.tenantId,
    user_id: ownerUserId,
    memory_key: input.memoryKey,
    memory_value: input.memoryValue,
    memory_type: input.memoryType,
    memory_tier: tierFor(input),
    confidence: confidenceFor(input),
    source: input.source,
    source_event_id: null,
    metadata: {},
    status: "accepted",
    expires_at: input.expiresAt ?? null,
    last_used_at: now,
    reviewed_by: userId,
    reviewed_at: now,
    created_by: userId,
  };

  let existingQ = sb
    .from("intelligence_memory")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("scope", input.scope)
    .eq("memory_key", input.memoryKey);
  existingQ = ownerUserId ? existingQ.eq("user_id", ownerUserId) : existingQ.is("user_id", null);
  const { data: existing } = await existingQ.maybeSingle();

  if (existing) {
    const { error } = await sb.from("intelligence_memory").update(row).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { id: existing.id as string, updated: true };
  }

  const { data, error } = await sb.from("intelligence_memory").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, updated: false };
}

/**
 * Returns this tenant's shared memory PLUS the caller's own personal
 * memory — never another staff member's personal rows (spec section 40).
 * Only "accepted" status is ever recalled into context or shown as active
 * — dismissed/superseded/expired rows are retrievable only via the
 * dedicated "what NOVA remembers" history view, not this default recall.
 */
export async function recallRestaurantMemory(
  sb: Sb,
  userId: string,
  input: RecallRestaurantMemoryInput,
): Promise<RestaurantMemory[]> {
  await assertTenantRead(sb, userId, input.tenantId);

  const queries: Promise<{ data: any[] | null }>[] = [];
  if (!input.scope || input.scope === "tenant") {
    let q = sb
      .from("intelligence_memory")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("scope", "tenant")
      .eq("status", "accepted")
      .is("user_id", null);
    if (input.memoryType) q = q.eq("memory_type", input.memoryType);
    queries.push(q);
  }
  if (!input.scope || input.scope === "user") {
    let q = sb
      .from("intelligence_memory")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("scope", "user")
      .eq("status", "accepted")
      .eq("user_id", userId);
    if (input.memoryType) q = q.eq("memory_type", input.memoryType);
    queries.push(q);
  }
  const results = await Promise.all(queries);
  const rows = results.flatMap((r) => r.data ?? []);
  rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return rows.slice(0, input.limit).map(toRestaurantMemory);
}

async function loadOwnedMemory(sb: Sb, userId: string, tenantId: string, memoryId: string) {
  const { data } = await sb
    .from("intelligence_memory")
    .select("*")
    .eq("id", memoryId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) throw new Error("Memory not found.");
  if (data.scope === "user") {
    if (data.user_id !== userId) {
      throw new Error("Forbidden — that's another staff member's personal memory.");
    }
  } else {
    await assertCanManageTenantMemory(sb, userId, tenantId);
  }
  return data;
}

/**
 * Never a hard delete — moves the row to "dismissed" (spec section 42:
 * "never hard-delete consequential audit evidence merely because a user
 * forgot a preference"). A personal memory can only ever be forgotten by
 * its own owner; a tenant memory requires the managerial role set above.
 */
export async function forgetRestaurantMemory(
  sb: Sb,
  userId: string,
  input: ForgetRestaurantMemoryInput,
): Promise<{ ok: true }> {
  const row = await loadOwnedMemory(sb, userId, input.tenantId, input.memoryId);
  const { error } = await sb
    .from("intelligence_memory")
    .update({
      status: "dismissed",
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * Updates the existing row's value in place rather than inserting a second,
 * contradicting row — the same ownership/role gate as forget. Correction
 * changes what NOVA remembers was said; it never changes what any
 * execution path re-derives from current operational tables (I13 always
 * re-reads current stock/price/authority regardless of this memory).
 */
export async function correctRestaurantMemory(
  sb: Sb,
  userId: string,
  input: CorrectRestaurantMemoryInput,
): Promise<{ ok: true }> {
  const row = await loadOwnedMemory(sb, userId, input.tenantId, input.memoryId);
  const { error } = await sb
    .from("intelligence_memory")
    .update({
      memory_value: input.memoryValue,
      status: "accepted",
      confidence: row.source === "user_stated" ? 1 : row.confidence,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * Any tenant member may leave feedback on their own interactions — it
 * never carries authority (spec: "must never directly grant permissions
 * or modify operational truth"), so no elevated role is required, matching
 * the migration's feedback INSERT policy.
 */
export async function submitRestaurantMemoryFeedback(
  sb: Sb,
  userId: string,
  input: SubmitRestaurantMemoryFeedbackInput,
): Promise<{ id: string }> {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("intelligence_feedback")
    .insert({
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      module: "restaurant",
      tenant_id: input.tenantId,
      stage: "learn",
      useful: input.useful ?? null,
      comment: input.comment ?? null,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string };
}

/**
 * INTERNAL ONLY — never exposed via memory.functions.ts, never callable
 * with caller-supplied source. Called exclusively from I13's
 * act/act.server.ts right after independent verification confirms a real
 * operational effect actually happened (spec section 47: "REMEMBER
 * VERIFIED OUTCOME... only after independently verified"). Written
 * pre-accepted (a verified fact needs no human confirmation step) and
 * tenant-wide (any staff member benefits from knowing what was done).
 *
 * memoryValue must stay a REFERENCE to the record (workflow, document
 * number, outcome), never a duplicate of the operational numbers
 * themselves (spec section 51: memory indexes, it does not duplicate) —
 * callers must pass a value built the same way; see act.server.ts's call
 * site for the exact string shape.
 */
export async function rememberVerifiedOutcome(
  sb: Sb,
  tenantId: string,
  input: { memoryKey: string; memoryValue: string; sourceEventId?: string | null },
): Promise<{ id: string; updated: boolean }> {
  const now = new Date().toISOString();
  const row = {
    scope: "tenant",
    scope_id: null,
    module: "restaurant",
    tenant_id: tenantId,
    user_id: null,
    memory_key: input.memoryKey,
    memory_value: input.memoryValue,
    memory_type: "verified_outcome",
    memory_tier: "observed",
    confidence: 1,
    source: "verified_outcome",
    source_event_id: input.sourceEventId ?? null,
    metadata: {},
    status: "accepted",
    last_used_at: now,
  };

  const { data: existing } = await sb
    .from("intelligence_memory")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("scope", "tenant")
    .is("user_id", null)
    .eq("memory_key", input.memoryKey)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from("intelligence_memory").update(row).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { id: existing.id as string, updated: true };
  }
  const { data, error } = await sb.from("intelligence_memory").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, updated: false };
}

/**
 * Read-only retrieval primitive for "what did we do about X" / "same as
 * before" questions — returns candidate verified-outcome memories whose
 * key matches a prefix (e.g. "stock_transfer:") so a caller can name a
 * candidate record and point the user back at it. Deliberately does NOT
 * resolve ambiguity, does NOT return actionable entity ids beyond the
 * memory's own reference text, and is never wired into an execution path:
 * a caller who wants to actually reuse "what we did last time" must still
 * go through I12's normal prepare flow, which re-derives every entity,
 * price, and quantity from current tables regardless of this result (spec
 * sections 44/55 — never blind-replay). Bounded to a handful of rows so it
 * can be shown to the user for THEM to choose, never auto-selected when
 * more than one plausible match exists (spec section 44: "ask if multiple
 * candidates").
 */
export async function findRecentVerifiedOutcomes(
  sb: Sb,
  userId: string,
  tenantId: string,
  keyPrefix: string,
  limit = 5,
): Promise<RestaurantMemory[]> {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("intelligence_memory")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("scope", "tenant")
    .eq("memory_type", "verified_outcome")
    .eq("status", "accepted")
    .ilike("memory_key", `${keyPrefix}%`)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRestaurantMemory);
}
