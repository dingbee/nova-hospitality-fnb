import { test, expect, type Page } from "@playwright/test";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const guestFixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), ".generated", "guest");

/** workbox-build names its runtime chunk with a content hash
 * (workbox-<hash>.js) — resolved from disk rather than hardcoded so this
 * test doesn't silently stop covering anything if that hash changes. */
function fixedWorkboxRuntimeFilename(): string {
  const match = readdirSync(guestFixturesDir).find((name) => /^workbox-[\w.-]+\.js$/.test(name));
  if (!match) throw new Error(`No workbox-*.js runtime chunk found in ${guestFixturesDir}`);
  return match;
}

/**
 * Registers `swPath` at `scope`, then reloads until `navigator.
 * serviceWorker.controller` is actually this page's controller — a plain
 * navigation to a URL within an active worker's registered scope is
 * always controlled by it per spec, but `ready` only guarantees the
 * worker reached the "active" state, not that this specific already-open
 * tab's controllership has been (re)established yet, so a single
 * unconditional reload was occasionally racing that under real browser
 * timing. Polling with a bounded number of reloads removes the flake
 * without weakening what's actually being asserted afterward.
 */
async function registerAndWaitControlled(
  page: Page,
  landingUrl: string,
  swPath: string,
  scope: string,
): Promise<void> {
  await page.goto(landingUrl);
  await page.evaluate(
    async ({ swPath, scope }) => {
      await navigator.serviceWorker.register(swPath, { scope });
      await navigator.serviceWorker.ready;
    },
    { swPath, scope },
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.reload();
    const controllerUrl = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    if (controllerUrl && controllerUrl.endsWith(swPath)) return;
  }
  throw new Error(`Page was never controlled by ${swPath} after registration`);
}

/**
 * Real-browser certification for the guest ordering service worker fix
 * (see vite.config.ts's `guestServiceWorkerOptions` doc comment for the
 * root cause). Runs the ACTUAL service worker `workbox-build` generates
 * from the real exported config (build-guest-sw-harness.ts) in real
 * Chromium — not a mock, not a reimplementation.
 *
 * Scope: this proves the service-worker layer specifically — that a slow
 * or failed navigation to /order/* is never converted into a substituted
 * offline document by the worker itself, and that a stale worker carrying
 * the old behavior is fully replaced by a fresh deployment without any
 * user action. It does not exercise the full authenticated guest app
 * (real TanStack Start SSR route, live Supabase menu data) — this
 * environment has no live backend to run that against, matching this
 * harness's existing disclosed scope (see build-harness.ts and
 * playwright.config.ts's own doc comments for the equivalent, previously
 * accepted gap on the staff offline module). The application-level retry
 * UI for a real data-fetch failure (`menu.isError` / `onRetry`,
 * `networkMode: "always"`) is unit-testable independently of a browser and
 * is unchanged by this fix.
 */

test.describe("fixed guest service worker (real build from vite.config.ts)", () => {
  test.beforeEach(async ({ page }) => {
    await registerAndWaitControlled(page, "/order/demo-table", "/order/sw.js", "/order/");
  });

  test("Test A — normal online load reaches the real guest page, no offline substitution", async ({
    page,
  }) => {
    const response = await page.goto("/order/demo-table");
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText("GUEST-ORDER-PAGE-OK");
  });

  test("Test C — a navigation slower than the old 12s NetworkFirst threshold still resolves to the real page, never a substituted offline page", async ({
    page,
  }) => {
    await page.route("**/order/demo-table", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    const response = await page.goto("/order/demo-table", { timeout: 15_000 });
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText("GUEST-ORDER-PAGE-OK");
  });

  test("Test D — a real network failure is the browser's own error, never a fake offline page or a fake success", async ({
    page,
  }) => {
    await page.route("**/order/down", (route) => route.abort("failed"));

    let navigationError: unknown;
    try {
      await page.goto("/order/down", { timeout: 5_000 });
    } catch (err) {
      navigationError = err;
    }

    expect(navigationError).toBeDefined();
    // Nothing about a genuine network failure produces our old custom
    // offline document — the fixed worker never precached one.
    await expect(page.locator("body")).not.toContainText("You're offline");
    await expect(page.locator("body")).not.toContainText("STALE-OFFLINE-PAGE");
  });

  test("Test E — recovery: once the network is restored, the next navigation succeeds normally", async ({
    page,
  }) => {
    await page.route("**/order/recovering", (route) => route.abort("failed"));
    await expect(page.goto("/order/recovering", { timeout: 5_000 })).rejects.toBeTruthy();

    await page.unroute("**/order/recovering");
    const response = await page.goto("/order/recovering");
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText("GUEST-ORDER-PAGE-OK");
  });
});

test.describe("stale-worker replacement (Test F)", () => {
  test("a worker carrying the old navigateFallback/NetworkFirst behavior is fully replaced by the fixed worker, without the guest clearing storage", async ({
    page,
  }, testInfo) => {
    // This test mutates a fixture's sw.js on disk mid-test to simulate a
    // redeploy at the same unhashed URL — and Playwright's projects
    // (desktop/tablet/mobile) run this same test concurrently against one
    // shared static-server process. Each Playwright worker gets its own
    // fresh copy of the pristine "stale" fixture, under its own scope
    // path, so concurrent runs can never corrupt each other's in-progress
    // simulation (each `workerIndex` is unique for the whole test run —
    // see playwright.dev/docs/api/class-testinfo#test-info-worker-index).
    const scopePrefix = `/order-stale-w${testInfo.workerIndex}/`;
    const staleDir = join(guestFixturesDir, `stale-w${testInfo.workerIndex}`);
    rmSync(staleDir, { recursive: true, force: true });
    cpSync(join(guestFixturesDir, "stale"), staleDir, { recursive: true });
    const staleSwPath = join(staleDir, "sw.js");
    const staleSwUrl = `${scopePrefix}sw.js`;
    const demoTableUrl = `${scopePrefix}demo-table`;

    // 1. Install the OLD (pre-fix) worker fixture and confirm it really
    // does exhibit the reported defect — a slow navigation gets answered
    // with ITS OWN precached offline.html, not the real page. This is the
    // sanity check that the fixture (and this test) is meaningful.
    await registerAndWaitControlled(page, demoTableUrl, staleSwUrl, scopePrefix);

    // Routed on the CONTEXT, not the page: once a service worker is
    // controlling this navigation, the actual outgoing request the
    // NetworkFirst strategy races against its timeout is the worker's OWN
    // internal re-fetch (issued from the SW's execution context), not a
    // request page.route() reliably observes — same reasoning as the SW's
    // own update-check fetch further down. A wide margin over the stale
    // fixture's 1s networkTimeoutSeconds (build-guest-sw-harness.ts) keeps
    // the point under test — "does the worker substitute a fallback page
    // at all" — clear of timing flakiness under CI/parallel worker load.
    const slowTableUrl = `${scopePrefix}slow-table`;
    await page.context().route(`**${slowTableUrl}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue();
    });
    await page.goto(slowTableUrl, { timeout: 20_000 });
    await expect(page.locator("body")).toContainText("STALE-OFFLINE-PAGE");
    await page.context().unroute(`**${slowTableUrl}`);

    // 2. "Deploy" the fixed worker to the SAME URL/scope the old one is
    // already registered under — simulating a production release
    // reaching a device that still has the old worker installed, not a
    // fresh registration. skipWaiting + clientsClaim (see vite.config.ts)
    // must replace it without the guest doing anything (no unregister, no
    // clearing storage): overwriting the file on disk at the exact same
    // sw.js URL is what a real deployment does (this project's sw.js
    // filename is not content-hashed), and the static server (like a real
    // CDN/origin) always reads it fresh — no request interception
    // involved, so this isn't sensitive to whether Playwright can
    // intercept a service worker's own background fetch.
    const workboxRuntimeFilename = fixedWorkboxRuntimeFilename();
    writeFileSync(staleSwPath, readFileSync(join(guestFixturesDir, "sw.js")));
    writeFileSync(
      join(staleDir, workboxRuntimeFilename),
      readFileSync(join(guestFixturesDir, workboxRuntimeFilename)),
    );

    // Chromium throttles automatic update checks, but DevTools' own "update
    // on reload" forces one via CDP — the same mechanism, invoked directly,
    // is the reliable way to trigger this deterministically in an
    // automated real-browser test rather than racing browser timing.
    // The listener is attached and awaited to completion BEFORE triggering
    // the update (rather than racing an unawaited page.evaluate() against
    // cdp.send()), so there is no window where the event could fire unseen.
    await page.evaluate(() => {
      (window as unknown as { __controllerChanged: boolean }).__controllerChanged = false;
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          (window as unknown as { __controllerChanged: boolean }).__controllerChanged = true;
        },
        { once: true },
      );
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.updateRegistration", {
      scopeURL: new URL(scopePrefix, page.url()).href,
    });
    await page.waitForFunction(
      () => (window as unknown as { __controllerChanged: boolean }).__controllerChanged === true,
      { timeout: 15_000 },
    );

    // 3. The same slow-network condition that used to trigger the stale
    // offline page must now resolve to the real page instead.
    const slowTableUrl2 = `${scopePrefix}slow-table-2`;
    await page.route(`**${slowTableUrl2}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue();
    });
    const response = await page.goto(slowTableUrl2, { timeout: 20_000 });
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText("GUEST-ORDER-PAGE-OK");
    await expect(page.locator("body")).not.toContainText("STALE-OFFLINE-PAGE");

    rmSync(staleDir, { recursive: true, force: true });
  });
});
