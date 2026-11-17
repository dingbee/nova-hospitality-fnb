/**
 * P10 Phase 11 — reliable connectivity state.
 *
 * `navigator.onLine` alone is well known to be unreliable: it reflects
 * whether the network *interface* is up, not whether this app's actual
 * backend is reachable (a captive portal, a VPN with no route to Supabase,
 * or a flaky Wi-Fi access point can all report `navigator.onLine === true`
 * while every real request fails). Rather than invent a new unauthenticated
 * health-check endpoint purely to probe reachability (out of this pass's
 * scope — that is API-surface design, not offline capability), this module
 * treats the browser's online/offline *events* as a cheap trigger for "it
 * might be worth trying now" and treats an actual attempted sync (a real
 * server-fn round trip, in syncEngine.ts) as the only authoritative
 * confirmation of connectivity. A period where the browser thinks it's
 * online but every sync attempt fails is surfaced as SYNC_ERROR, never
 * silently reported as ONLINE.
 */

export type ConnectivityState =
  "ONLINE" | "OFFLINE" | "SYNCING" | "SYNCED" | "SYNC_ERROR" | "STALE";

type Listener = (browserOnline: boolean) => void;

const listeners = new Set<Listener>();
let attached = false;

function handleChange() {
  const online = browserReportsOnline();
  for (const l of listeners) l(online);
}

export function browserReportsOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/** Subscribes to the browser's online/offline events. Returns an
 * unsubscribe function. Attaches the underlying window listeners at most
 * once no matter how many callers subscribe (P10 Phase 19 "prevent
 * duplicate listeners"). */
export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  if (!attached && typeof window !== "undefined") {
    window.addEventListener("online", handleChange);
    window.addEventListener("offline", handleChange);
    attached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && attached && typeof window !== "undefined") {
      window.removeEventListener("online", handleChange);
      window.removeEventListener("offline", handleChange);
      attached = false;
    }
  };
}

/** Test-only: forces the module back to its unattached state so tests don't
 * leak listeners into each other. */
export function resetConnectivityForTests() {
  listeners.clear();
  if (attached && typeof window !== "undefined") {
    window.removeEventListener("online", handleChange);
    window.removeEventListener("offline", handleChange);
  }
  attached = false;
}
