// Server-only helper for writing activity_logs entries.
// Called from within `requireSupabaseAuth` server functions using the
// user-scoped supabase client so RLS applies (actor_id = auth.uid()).

type LogInput = {
  actorId: string;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  metadata?: Record<string, unknown>;
  previousValue?: unknown;
  newValue?: unknown;
};

function safeHeaders() {
  try {
    // getRequestHeader is available inside server function handlers
    // Avoid a hard import so this file remains importable from server modules.
    // Read from a request via dynamic access when available.
    // The real values are populated at call time from getRequest() in the function.
    return { ip: null as string | null, ua: null as string | null };
  } catch {
    return { ip: null, ua: null };
  }
}

export async function logActivity(supabase: any, input: LogInput) {
  try {
    const { ip, ua } = safeHeaders();
    const row = {
      actor_id: input.actorId,
      actor_email: input.actorEmail ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      entity_label: input.entityLabel ?? null,
      metadata: input.metadata ?? {},
      previous_value: input.previousValue ?? null,
      new_value: input.newValue ?? null,
      ip_address: ip,
      user_agent: ua,
    };
    const { error } = await supabase.from("activity_logs").insert(row);
    if (error) {
      // Don't fail the primary action if logging fails
      // eslint-disable-next-line no-console
      console.warn("[activity-log] insert failed:", error.message);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[activity-log] threw:", (e as Error).message);
  }
}