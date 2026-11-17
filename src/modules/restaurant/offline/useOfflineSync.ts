/**
 * P10 Phase 11/12 — the one hook the POS UI needs: connectivity state,
 * queue status, and functions to queue the three OFFLINE_QUEUEABLE
 * operations. Wires device registration, connectivity subscription, and
 * automatic sync-on-reconnect together; owns no business logic of its own
 * — it calls queue.ts/syncEngine.ts/device.ts, which own it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { posSyncCallers } from "./adapters";
import type { ConnectivityState } from "./connectivity";
import { browserReportsOnline, subscribeConnectivity } from "./connectivity";
import type { QueueableOperationType, QueuedOperation } from "./contracts";
import { detectDeviceContextChange, getDeviceIdentity, registerDevice } from "./device";
import { enqueue } from "./queue";
import { syncPendingQueue, syncStatusFor, type OrderRef } from "./syncEngine";

export interface OfflineSyncStatus {
  connectivity: ConnectivityState;
  pending: number;
  processing: number;
  conflicts: number;
  deadLettered: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface UseOfflineSyncArgs {
  tenantId: string | undefined;
  propertyId: string | null;
  outletId: string | null;
}

function newClientRequestId(): string {
  return crypto.randomUUID();
}

export function useOfflineSync({ tenantId, propertyId, outletId }: UseOfflineSyncArgs) {
  const [status, setStatus] = useState<OfflineSyncStatus>({
    connectivity: browserReportsOnline() ? "ONLINE" : "OFFLINE",
    pending: 0,
    processing: 0,
    conflicts: 0,
    deadLettered: 0,
    lastSyncedAt: null,
    lastSyncError: null,
  });
  const wasOnline = useRef(browserReportsOnline());
  // Resolved from device.ts's own persisted identity, never invented here —
  // registerDevice returns the SAME deviceId across calls once one exists
  // (see device.ts's doc comment), so this is stable across this hook's
  // effects without needing to be threaded in from a caller who has no
  // legitimate reason to mint its own device id.
  const deviceIdRef = useRef<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!tenantId) return;
    const s = await syncStatusFor(tenantId);
    setStatus((prev) => ({
      ...prev,
      pending: s.pending,
      processing: s.processing,
      conflicts: s.conflicts,
      deadLettered: s.deadLettered,
    }));
  }, [tenantId]);

  const runSync = useCallback(async () => {
    if (!tenantId) return;
    setStatus((prev) => ({ ...prev, connectivity: "SYNCING" }));
    try {
      const summary = await syncPendingQueue(tenantId, posSyncCallers);
      await refreshStatus();
      setStatus((prev) => ({
        ...prev,
        connectivity:
          summary.deadLettered > 0 || summary.conflicts > 0
            ? "SYNC_ERROR"
            : browserReportsOnline()
              ? "SYNCED"
              : "OFFLINE",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
      }));
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        connectivity: "SYNC_ERROR",
        lastSyncError: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tenantId, refreshStatus]);

  // Register/reconcile device identity whenever the signed-in scope is
  // known. A tenant/outlet change is never silently followed — see
  // device.ts's detectDeviceContextChange doc comment.
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void (async () => {
      const change = await detectDeviceContextChange({ tenantId, propertyId, outletId });
      if (cancelled) return;
      const identity =
        change.kind !== "none"
          ? await registerDevice({ tenantId, propertyId, outletId })
          : await getDeviceIdentity();
      if (cancelled) return;
      deviceIdRef.current = identity?.deviceId ?? null;
      await refreshStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, outletId, refreshStatus]);

  // Connectivity subscription: flips the UI state immediately on browser
  // events, and triggers exactly one sync attempt on an offline→online
  // transition (never on online→online or a duplicate event — subscribing
  // once per mount, per connectivity.ts's own de-duplication).
  useEffect(() => {
    if (!tenantId) return;
    const unsubscribe = subscribeConnectivity((online) => {
      if (online && !wasOnline.current) {
        setStatus((prev) => ({ ...prev, connectivity: "SYNCING" }));
        void runSync();
      } else if (!online) {
        setStatus((prev) => ({ ...prev, connectivity: "OFFLINE" }));
      }
      wasOnline.current = online;
    });
    return unsubscribe;
  }, [tenantId, runSync]);

  // Initial mount: if already online with pending work (e.g. a refresh
  // right after coming back online before the sync finished), attempt a
  // sync once; otherwise just populate counts.
  useEffect(() => {
    if (!tenantId) return;
    void refreshStatus();
    if (browserReportsOnline()) void runSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const queueOpenOrder = useCallback(
    async (payload: Record<string, unknown>): Promise<QueuedOperation> => {
      if (!tenantId) throw new Error("No tenant context — cannot queue offline work.");
      if (!deviceIdRef.current)
        throw new Error("Device identity not yet registered — cannot queue offline work.");
      const clientRequestId = newClientRequestId();
      const op = await enqueue({
        clientRequestId,
        deviceId: deviceIdRef.current,
        tenantId,
        propertyId,
        outletId,
        operationType: "open_order",
        payload: { ...payload, tenantId, clientRequestId },
      });
      void refreshStatus();
      return op;
    },
    [tenantId, propertyId, outletId, refreshStatus],
  );

  const queueAddItems = useCallback(
    async (
      orderRef: OrderRef,
      lines: unknown[],
      dependsOnOperationId: string | null,
    ): Promise<QueuedOperation> => {
      if (!tenantId) throw new Error("No tenant context — cannot queue offline work.");
      if (!deviceIdRef.current)
        throw new Error("Device identity not yet registered — cannot queue offline work.");
      const clientRequestId = newClientRequestId();
      const op = await enqueue({
        clientRequestId,
        deviceId: deviceIdRef.current,
        tenantId,
        propertyId,
        outletId,
        operationType: "add_item",
        dependsOnOperationId,
        payload: { tenantId, orderRef, lines, clientRequestId },
      });
      void refreshStatus();
      return op;
    },
    [tenantId, propertyId, outletId, refreshStatus],
  );

  const queueFireToKitchen = useCallback(
    async (orderRef: OrderRef, dependsOnOperationId: string | null): Promise<QueuedOperation> => {
      if (!tenantId) throw new Error("No tenant context — cannot queue offline work.");
      if (!deviceIdRef.current)
        throw new Error("Device identity not yet registered — cannot queue offline work.");
      const clientRequestId = newClientRequestId();
      const op = await enqueue({
        clientRequestId,
        deviceId: deviceIdRef.current,
        tenantId,
        propertyId,
        outletId,
        operationType: "fire_to_kitchen",
        dependsOnOperationId,
        payload: { tenantId, orderRef },
      });
      void refreshStatus();
      return op;
    },
    [tenantId, propertyId, outletId, refreshStatus],
  );

  return {
    status,
    isOffline: status.connectivity === "OFFLINE",
    queueOpenOrder,
    queueAddItems,
    queueFireToKitchen,
    runSync,
    refreshStatus,
  };
}

export type { QueueableOperationType };
