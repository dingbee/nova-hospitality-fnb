/**
 * P10 Phase 5 — offline session boundary.
 *
 * This module owns no authentication logic. Every server function this
 * offline capability replays is still gated by `requireSupabaseAuth`
 * (src/integrations/supabase/auth-middleware.ts), which validates a bearer
 * token fresh on every single call via `supabase.auth.getClaims`. Local
 * storage is never a trust boundary (P10 Phase 17) — this file exists only
 * to decide, for UX purposes, whether it is worth letting an operator keep
 * drafting offline work with the session this device currently has cached,
 * never to grant or extend access itself.
 *
 * `supabase.auth.getSession()` resolves from the SDK's own localStorage
 * persistence (persistSession: true in client.ts) without requiring
 * network access, so this is safe to call while genuinely offline.
 */
import { supabase } from "@/integrations/supabase/client";

export type OfflineSessionStatus = "unauthenticated" | "valid" | "expiring_soon" | "expired";

export interface OfflineSessionState {
  status: OfflineSessionStatus;
  userId: string | null;
  expiresAt: number | null;
}

const EXPIRING_SOON_WINDOW_SECONDS = 5 * 60;

/**
 * P10 Phase 5's explicit scenarios:
 *  - session token expired offline → "expired": the UI (useOfflineSession)
 *    must stop offering to queue new writes and tell the operator to
 *    reconnect and sign in again. Already-queued operations are untouched —
 *    they simply cannot sync until a valid token exists again, which the
 *    sync engine enforces by calling the real server function (which will
 *    itself reject an expired token) rather than trusting this check.
 *  - signed out → "unauthenticated": same treatment.
 *  - user/device/tenant changed → not this module's concern; see
 *    device.ts's detectDeviceContextChange, called separately.
 *  - authorization revoked while offline → cannot be known locally by
 *    construction (revocation is a server-side RBAC/RLS fact); the queued
 *    operation simply fails server-side on sync and is surfaced as a
 *    conflict/dead-letter, never silently accepted.
 */
export async function getOfflineSessionState(): Promise<OfflineSessionState> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return { status: "unauthenticated", userId: null, expiresAt: null };

  const expiresAt = session.expires_at ?? null;
  const userId = session.user?.id ?? null;
  if (expiresAt === null) return { status: "valid", userId, expiresAt };

  const nowSeconds = Date.now() / 1000;
  if (expiresAt <= nowSeconds) return { status: "expired", userId, expiresAt };
  if (expiresAt - nowSeconds <= EXPIRING_SOON_WINDOW_SECONDS) {
    return { status: "expiring_soon", userId, expiresAt };
  }
  return { status: "valid", userId, expiresAt };
}

/** Whether the UI should currently allow drafting new offline-queueable
 * work. "expiring_soon" is still allowed — the token may well outlive the
 * offline period or refresh the moment connectivity returns — only
 * "expired"/"unauthenticated" block new queueing. Already-queued work is
 * never blocked from being *displayed*; only new enqueue calls consult
 * this. */
export function canQueueNewOfflineWork(state: OfflineSessionState): boolean {
  return state.status === "valid" || state.status === "expiring_soon";
}
