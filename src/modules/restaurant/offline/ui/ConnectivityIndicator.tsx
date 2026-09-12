/**
 * P10 Phase 11 — connectivity/sync UX. Shows exactly the states the
 * mission requires (ONLINE/OFFLINE/SYNCING/SYNCED/SYNC_ERROR/STALE), the
 * pending/conflict/dead-letter counts, and the last successful sync time —
 * never a vague "working..." indicator, and never hides a failure.
 */
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import type { OfflineSyncStatus } from "../useOfflineSync";

function toneFor(connectivity: OfflineSyncStatus["connectivity"]): StatusTone {
  switch (connectivity) {
    case "ONLINE":
    case "SYNCED":
      return "success";
    case "SYNCING":
      return "info";
    case "OFFLINE":
    case "STALE":
      return "warning";
    case "SYNC_ERROR":
      return "danger";
  }
}

function labelFor(connectivity: OfflineSyncStatus["connectivity"]): string {
  switch (connectivity) {
    case "ONLINE":
      return "Online";
    case "OFFLINE":
      return "Offline";
    case "SYNCING":
      return "Syncing…";
    case "SYNCED":
      return "Synced";
    case "SYNC_ERROR":
      return "Sync error";
    case "STALE":
      return "Stale data";
  }
}

export function ConnectivityIndicator({ status }: { status: OfflineSyncStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="connectivity-indicator">
      <span data-testid="connectivity-state">
        <StatusChip tone={toneFor(status.connectivity)}>{labelFor(status.connectivity)}</StatusChip>
      </span>
      {status.pending > 0 && (
        <span data-testid="pending-count">
          <StatusChip tone="warning">{status.pending} pending</StatusChip>
        </span>
      )}
      {status.processing > 0 && <StatusChip tone="info">{status.processing} syncing</StatusChip>}
      {status.conflicts > 0 && (
        <span data-testid="conflict-count">
          <StatusChip tone="danger">{status.conflicts} need attention</StatusChip>
        </span>
      )}
      {status.deadLettered > 0 && (
        <StatusChip tone="danger">{status.deadLettered} failed</StatusChip>
      )}
      {status.lastSyncedAt && (
        <span className="text-[color:var(--os-ink-3)]">
          Last synced {new Date(status.lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
      {status.lastSyncError && (
        <span className="text-[color:var(--os-danger-strong)]">{status.lastSyncError}</span>
      )}
    </div>
  );
}
