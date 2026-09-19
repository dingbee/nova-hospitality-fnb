import { WifiOff } from "lucide-react";
import type { OfflineSyncStatus } from "@/modules/restaurant/offline/useOfflineSync";

/**
 * Compact, persistent offline state — never a full-screen takeover. The POS
 * stays usable for whatever the offline queue already supports; this only
 * makes the state visible so staff never mistake a queued action for a
 * server-confirmed one.
 */
export function MobileOfflineBanner({ status }: { status: OfflineSyncStatus }) {
  if (status.connectivity === "ONLINE" || status.connectivity === "SYNCED") {
    return status.pending > 0 ? (
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-4 py-1.5 text-xs font-medium text-amber-900"
        style={{ background: "#FDF3E0" }}
        data-testid="mobile-pending-banner"
      >
        <span>
          {status.pending} order{status.pending === 1 ? "" : "s"} syncing to the server…
        </span>
      </div>
    ) : null;
  }

  if (status.connectivity === "SYNCING") {
    return (
      <div
        className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs font-medium text-sky-900"
        style={{ background: "#E7F1FB" }}
      >
        <span>Reconnected — syncing queued orders…</span>
      </div>
    );
  }

  return (
    <div
      className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs font-medium text-amber-900"
      style={{ background: "#FDF3E0" }}
      data-testid="mobile-offline-banner"
      role="status"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <span>
        You are offline — orders will queue on this device and sync when connection is restored
        {status.pending > 0 ? ` (${status.pending} queued)` : ""}.
      </span>
    </div>
  );
}
