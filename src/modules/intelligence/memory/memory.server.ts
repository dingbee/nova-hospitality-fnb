/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Learn — durable memory and feedback.
 *
 * Memory is human-curated: new entries start as `new` and only approved
 * entries are recalled into reasoning by default.
 */
import type { RecallInput, RememberInput, ReviewMemoryInput, SubmitFeedbackInput } from "../core/contracts";
import { assertIntelDecide, assertIntelRead } from "../core/access.server";

type Sb = any;

export async function remember(supabase: Sb, userId: string, input: RememberInput) {
  await assertIntelRead(supabase, userId);
  const row = {
    scope: input.scope,
    scope_id: input.scopeId ?? null,
    module: input.module ?? null,
    memory_key: input.memoryKey,
    memory_value: input.memoryValue,
    memory_type: input.memoryType,
    memory_tier: input.memoryTier,
    confidence: input.confidence,
    source: input.source,
    source_event_id: input.sourceEventId ?? null,
    metadata: input.metadata,
    expires_at: input.expiresAt ?? null,
    last_used_at: new Date().toISOString(),
  };

  // Reinforce an existing memory in the same scope instead of duplicating it.
  let existingQ = supabase
    .from("intelligence_memory")
    .select("id")
    .eq("scope", input.scope)
    .eq("memory_key", input.memoryKey);
  existingQ = input.scopeId ? existingQ.eq("scope_id", input.scopeId) : existingQ.is("scope_id", null);
  const { data: existing } = await existingQ.maybeSingle();

  if (existing) {
    const { error } = await supabase.from("intelligence_memory").update(row).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { id: existing.id as string, updated: true };
  }

  const { data, error } = await supabase.from("intelligence_memory").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, updated: false };
}

export async function recall(supabase: Sb, userId: string, input: RecallInput) {
  await assertIntelRead(supabase, userId);
  let q = supabase
    .from("intelligence_memory")
    .select("*")
    .order("confidence", { ascending: false })
    .order("last_used_at", { ascending: false })
    .limit(input.limit);
  if (input.scope) q = q.eq("scope", input.scope);
  if (input.scopeId) q = q.eq("scope_id", input.scopeId);
  if (input.module) q = q.eq("module", input.module);
  if (input.memoryTier) q = q.eq("memory_tier", input.memoryTier);
  if (input.status) q = q.eq("status", input.status);
  else if (input.approvedOnly) q = q.eq("status", "accepted");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function reviewMemory(supabase: Sb, userId: string, input: ReviewMemoryInput) {
  await assertIntelDecide(supabase, userId);
  const patch: Record<string, unknown> = {
    status: input.status,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
  };
  if (input.memoryValue) patch.memory_value = input.memoryValue;
  const { error } = await supabase.from("intelligence_memory").update(patch).eq("id", input.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

export async function submitFeedback(supabase: Sb, userId: string, input: SubmitFeedbackInput) {
  await assertIntelRead(supabase, userId);
  const { data, error } = await supabase
    .from("intelligence_feedback")
    .insert({
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      module: input.module ?? null,
      stage: input.stage ?? null,
      rating: input.rating ?? null,
      useful: input.useful ?? null,
      correction: input.correction ?? null,
      comment: input.comment ?? null,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string };
}