/* eslint-disable @typescript-eslint/no-explicit-any -- this is the one place the offline module's generic queued payloads cross into the strict, Zod-validated real server-function inputs; matches the existing boundary convention in pos.server.ts/sales.server.ts. */
/**
 * P10 Phase 3/9 — adapters binding the sync engine's generic `SyncCallers`
 * interface to the REAL, existing POS/kitchen server functions. This is
 * the one place the offline module talks to `openPosOrderFn`/
 * `addPosLinesFn`/`fireRestaurantOrderFn` — the exact same TanStack server
 * functions the online POS calls, via `attachSupabaseAuth`'s existing
 * bearer-token middleware. No parallel transactional path, no duplicated
 * business logic: a queued operation replays through literally the same
 * code the online till uses.
 */
import { openPosOrderFn, addPosLinesFn } from "@/modules/restaurant/sales/pos.functions";
import { fireRestaurantOrderFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import type { SyncCallers } from "./syncEngine";

export const posSyncCallers: SyncCallers = {
  openOrder: (payload) => openPosOrderFn({ data: payload as any }) as any,
  addItems: (payload) =>
    addPosLinesFn({
      data: {
        tenantId: payload.tenantId,
        orderId: payload.orderId,
        lines: payload.lines as any,
        clientRequestId: payload.clientRequestId,
      },
    }) as any,
  fireToKitchen: (payload) =>
    fireRestaurantOrderFn({
      data: {
        tenantId: payload.tenantId,
        orderId: payload.orderId,
        orderItemIds: payload.orderItemIds ?? [],
        priority: payload.priority ?? 0,
      },
    }) as any,
};
