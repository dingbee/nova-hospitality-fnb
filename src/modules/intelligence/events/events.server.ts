/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Observe — the intake of the Intelligence Core.
 * Every module writes facts here; nothing reasons at this stage.
 */
import type { ListEventsInput, RecordEventInput } from "../core/contracts";
import { assertIntelRead, visibleModules } from "../core/access.server";

type Sb = any;

/** Idempotent: a repeated `dedupeKey` returns the existing event. */
export async function recordEvent(supabase: Sb, userId: string, input: RecordEventInput) {
  await assertIntelRead(supabase, userId);

  if (input.dedupeKey) {
    const { data: existing } = await supabase
      .from("intelligence_events")
      .select("id")
      .eq("dedupe_key", input.dedupeKey)
      .maybeSingle();
    if (existing) return { id: existing.id as string, duplicate: true };
  }

  const { data, error } = await supabase
    .from("intelligence_events")
    .insert({
      module: input.module,
      event_type: input.eventType,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      actor_id: userId,
      source: input.source,
      severity: input.severity,
      payload: input.payload,
      correlation_id: input.correlationId ?? null,
      dedupe_key: input.dedupeKey ?? null,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    // Unique violation → another writer won the race; treat as duplicate.
    if (String(error.code) === "23505" && input.dedupeKey) return { id: null, duplicate: true };
    throw new Error(error.message);
  }
  return { id: data.id as string, duplicate: false };
}

export async function listEvents(supabase: Sb, userId: string, input: ListEventsInput) {
  await assertIntelRead(supabase, userId);
  const modules = await visibleModules(supabase, userId);

  let q = supabase
    .from("intelligence_events")
    .select("id, module, event_type, entity_type, entity_id, severity, source, payload, occurred_at, processed_at")
    .in("module", input.module ? modules.filter((m) => m === input.module) : modules)
    .order("occurred_at", { ascending: false })
    .limit(input.limit);

  if (input.eventType) q = q.eq("event_type", input.eventType);
  if (input.entityId) q = q.eq("entity_id", input.entityId);
  if (input.unprocessedOnly) q = q.is("processed_at", null);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Mark events as consumed by an understanding pass. */
export async function markEventsProcessed(supabase: Sb, ids: string[]) {
  if (ids.length === 0) return 0;
  const { error } = await supabase
    .from("intelligence_events")
    .update({ processed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
  return ids.length;
}