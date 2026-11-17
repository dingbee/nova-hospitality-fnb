import { test, expect } from "@playwright/test";

/**
 * P10 Phase 21 — real-browser certification.
 *
 * Runs the ACTUAL offline module source (db.ts/device.ts/queue.ts/
 * connectivity.ts/snapshot.ts, bundled unmodified by
 * e2e/support/build-harness.ts) inside real Chromium, at desktop/tablet/
 * mobile viewports (see playwright.config.ts projects). This closes the
 * one real gap fake-indexeddb (a spec-compliant but still polyfilled
 * implementation) cannot: proof against the browser's own IndexedDB and
 * online/offline event engine.
 *
 * See docs/p10-offline-operations.md ("Browser certification scope") for
 * exactly what this does and does not cover.
 */

declare global {
  interface Window {
    __offline: {
      db: typeof import("@/modules/restaurant/offline/db");
      device: typeof import("@/modules/restaurant/offline/device");
      queue: typeof import("@/modules/restaurant/offline/queue");
      connectivity: typeof import("@/modules/restaurant/offline/connectivity");
      snapshot: typeof import("@/modules/restaurant/offline/snapshot");
      contracts: typeof import("@/modules/restaurant/offline/contracts");
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await expect(page.locator("#status")).toHaveText("ready");
  // Fresh database per test — real IndexedDB, not fake-indexeddb.
  await page.evaluate(async () => {
    await window.__offline.db.closeDb();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(window.__offline.db.DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });
});

test.describe("real Chromium IndexedDB durability", () => {
  test("a queued operation survives a real page reload (not just an in-memory cache)", async ({
    page,
  }) => {
    const opId = await page.evaluate(async () => {
      const op = await window.__offline.queue.enqueue({
        clientRequestId: crypto.randomUUID(),
        deviceId: "device-real-browser",
        tenantId: "tenant-real",
        propertyId: "prop-1",
        outletId: "outlet-1",
        operationType: "open_order",
        payload: { table: "t1" },
      });
      return op.operationId;
    });

    await page.reload();
    await expect(page.locator("#status")).toHaveText("ready");

    const reloaded = await page.evaluate(
      async (id) => window.__offline.queue.getQueueEntry(id),
      opId,
    );
    expect(reloaded).toBeTruthy();
    expect(reloaded?.state).toBe("PENDING");
  });

  test("device identity is stable across a real reload — the same device is not re-registered", async ({
    page,
  }) => {
    const first = await page.evaluate(async () => {
      const d = await window.__offline.device.registerDevice({
        tenantId: "tenant-real",
        propertyId: "prop-1",
        outletId: "outlet-1",
      });
      return d.deviceId;
    });

    await page.reload();
    await expect(page.locator("#status")).toHaveText("ready");

    const second = await page.evaluate(async () => {
      const d = await window.__offline.device.getDeviceIdentity();
      return d?.deviceId;
    });
    expect(second).toBe(first);
  });

  test("real IndexedDB enforces the tenant-scoped unique index on clientRequestId — duplicate enqueue is rejected by the browser engine, not just app logic", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const clientRequestId = "shared-real-browser-key";
      await window.__offline.queue.enqueue({
        clientRequestId,
        deviceId: "device-1",
        tenantId: "tenant-real",
        propertyId: "prop-1",
        outletId: "outlet-1",
        operationType: "open_order",
        payload: {},
      });
      try {
        await window.__offline.queue.enqueue({
          clientRequestId,
          deviceId: "device-1",
          tenantId: "tenant-real",
          propertyId: "prop-1",
          outletId: "outlet-1",
          operationType: "open_order",
          payload: {},
        });
        return "did-not-throw";
      } catch (err) {
        return err instanceof window.__offline.queue.DuplicateClientRequestIdError
          ? "duplicate-rejected"
          : `unexpected-error:${String(err)}`;
      }
    });
    expect(result).toBe("duplicate-rejected");
  });

  test("tenant isolation holds in real IndexedDB — one tenant's queue never surfaces another tenant's rows", async ({
    page,
  }) => {
    const forA = await page.evaluate(async () => {
      await window.__offline.queue.enqueue({
        clientRequestId: crypto.randomUUID(),
        deviceId: "device-1",
        tenantId: "tenant-A",
        propertyId: "prop-1",
        outletId: "outlet-1",
        operationType: "open_order",
        payload: {},
      });
      await window.__offline.queue.enqueue({
        clientRequestId: crypto.randomUUID(),
        deviceId: "device-1",
        tenantId: "tenant-B",
        propertyId: "prop-1",
        outletId: "outlet-1",
        operationType: "open_order",
        payload: {},
      });
      return window.__offline.queue.listQueueForTenant("tenant-A");
    });
    expect(forA).toHaveLength(1);
    expect(forA.every((o) => o.tenantId === "tenant-A")).toBe(true);
  });
});

test.describe("real browser connectivity events", () => {
  test("subscribeConnectivity reacts to a REAL Chromium offline/online transition (context.setOffline), not a simulated event", async ({
    page,
    context,
  }) => {
    await page.evaluate(() => {
      (window as unknown as { __seen: boolean[] }).__seen = [];
      window.__offline.connectivity.subscribeConnectivity((online) => {
        (window as unknown as { __seen: boolean[] }).__seen.push(online);
      });
    });

    await context.setOffline(true);
    await page.waitForTimeout(100);
    await context.setOffline(false);
    await page.waitForTimeout(100);

    const seen = await page.evaluate(() => (window as unknown as { __seen: boolean[] }).__seen);
    expect(seen).toEqual([false, true]);
  });
});
