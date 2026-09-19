/**
 * ME-16 remediation (ME16-09) — hosted-runtime readiness check.
 *
 * `/api/v1/health` (src/server.ts) is deliberately liveness-only: it must
 * stay cheap and answer even when a dependency is down, so an operator can
 * tell "the process is up" from "the process can serve traffic" (this
 * file). This performs exactly one cheap, read-only, HEAD-only query
 * (no rows returned) against Supabase with a hard timeout, and never
 * throws, never returns a stack trace, SQL, or connection string.
 */
import { resolveBuildIdentity } from "./build-info";

export interface ReadinessResult {
  ready: boolean;
  service: string;
  version: string;
  buildId: string;
  checkedAt: string;
  reason?: "database_unreachable";
}

const READINESS_TIMEOUT_MS = 3000;

export async function checkReadiness(service: string): Promise<ReadinessResult> {
  const identity = resolveBuildIdentity();
  const checkedAt = new Date().toISOString();
  const base = { service, version: identity.appVersion, buildId: identity.buildId, checkedAt };

  try {
    // Loaded lazily: constructing the admin client throws synchronously
    // when Supabase env vars are missing, and that is itself a legitimate
    // "not ready" state, not a crash of this endpoint.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
    try {
      const { error } = await supabaseAdmin
        .from("restaurant_tenants")
        .select("id", { head: true, count: "exact" })
        .limit(1)
        .abortSignal(controller.signal);
      if (error) return { ...base, ready: false, reason: "database_unreachable" };
      return { ...base, ready: true };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ...base, ready: false, reason: "database_unreachable" };
  }
}
