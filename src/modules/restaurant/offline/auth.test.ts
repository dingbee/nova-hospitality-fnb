import { describe, expect, it, vi } from "vitest";

/**
 * This module deliberately owns no auth logic of its own — it reads
 * whatever the existing Supabase SDK has persisted client-side
 * (`supabase.auth.getSession()`). The mock below stands in for exactly
 * that one call; everything else about the real client (token refresh,
 * localStorage persistence) is the SDK's own, already-tested behavior,
 * not this module's.
 */
const getSession = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));

const { getOfflineSessionState, canQueueNewOfflineWork } = await import("./auth");

function sessionWithExpiry(expiresAt: number | null, userId = "user-1") {
  return {
    data: { session: { access_token: "t", expires_at: expiresAt, user: { id: userId } } },
  };
}

describe("offline session boundary", () => {
  it("no session at all → unauthenticated, and new offline work is blocked", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const state = await getOfflineSessionState();
    expect(state.status).toBe("unauthenticated");
    expect(state.userId).toBeNull();
    expect(canQueueNewOfflineWork(state)).toBe(false);
  });

  it("a session with a future expiry → valid, offline work allowed", async () => {
    const farFuture = Date.now() / 1000 + 60 * 60;
    getSession.mockResolvedValue(sessionWithExpiry(farFuture));
    const state = await getOfflineSessionState();
    expect(state.status).toBe("valid");
    expect(state.userId).toBe("user-1");
    expect(canQueueNewOfflineWork(state)).toBe(true);
  });

  it("a session expiring within the warning window → expiring_soon, still allowed (P10: the token may outlive the offline period)", async () => {
    const soon = Date.now() / 1000 + 60; // 1 minute out, inside the 5-minute window
    getSession.mockResolvedValue(sessionWithExpiry(soon));
    const state = await getOfflineSessionState();
    expect(state.status).toBe("expiring_soon");
    expect(canQueueNewOfflineWork(state)).toBe(true);
  });

  it("an already-expired session → expired, new offline work is BLOCKED — this is the security-critical boundary", async () => {
    const past = Date.now() / 1000 - 60;
    getSession.mockResolvedValue(sessionWithExpiry(past));
    const state = await getOfflineSessionState();
    expect(state.status).toBe("expired");
    expect(canQueueNewOfflineWork(state)).toBe(false);
  });

  it("a session with no expiry field at all is treated as valid (never crashes on a missing field)", async () => {
    getSession.mockResolvedValue(sessionWithExpiry(null));
    const state = await getOfflineSessionState();
    expect(state.status).toBe("valid");
  });

  it("never invents a session from nothing: a rejected getSession call propagates rather than being silently treated as authenticated", async () => {
    getSession.mockRejectedValue(new Error("network unreachable"));
    await expect(getOfflineSessionState()).rejects.toThrow("network unreachable");
  });
});
