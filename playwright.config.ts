import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// P09 — this pinned path matches the dev sandbox's pre-installed Chromium
// revision only; a standard CI runner (GitHub Actions) has no such path and
// instead gets its own browser via a normal `playwright install chromium`
// step, landing in Playwright's own default cache location. Falling back to
// `undefined` here (rather than requiring this exact path) lets Playwright
// resolve that default install instead of failing to find a file that only
// exists in this one sandboxed environment.
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const chromiumExecutablePath = existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined;

/**
 * P10 Phase 21 — real-browser certification for the offline module.
 *
 * Scope (see docs/p10-offline-operations.md, "Browser certification
 * scope"): this exercises the real db.ts/device.ts/queue.ts/
 * connectivity.ts/snapshot.ts source in actual Chromium IndexedDB and
 * online/offline-event semantics, via a static harness built from the
 * unmodified module source (e2e/support/build-harness.ts) — not the full
 * authenticated POS UI. Full end-to-end certification of the
 * open-order -> offline -> reconnect -> sync -> server-ack flow against
 * live auth/data was evaluated and deliberately not attempted in this
 * environment: TanStack Start server functions call Supabase directly
 * from the Node server process, so browser-level request mocking cannot
 * safely stand in for a real backend, and this repository's own
 * governing rules forbid exercising that flow against real production
 * tenant data "casually." That gap is disclosed, not hidden.
 *
 * Uses the pre-installed Chromium (matches this environment's pinned
 * revision) rather than triggering a browser download.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  globalSetup: "./e2e/support/build-harness.ts",
  use: {
    baseURL: `http://127.0.0.1:${process.env.HARNESS_PORT ?? 4310}`,
  },
  webServer: {
    command: "bun run e2e/support/static-server.ts",
    port: Number(process.env.HARNESS_PORT ?? 4310),
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: ["--no-sandbox"],
        },
      },
    },
    {
      name: "tablet-chromium",
      use: {
        ...devices["iPad (gen 7)"],
        // The "iPad (gen 7)" preset defaults to WebKit, which is not
        // installed in this environment (Chromium only) — force Chromium
        // while keeping the device's viewport/touch/UA emulation.
        defaultBrowserType: "chromium",
        browserName: "chromium",
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: ["--no-sandbox"],
        },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: ["--no-sandbox"],
        },
      },
    },
  ],
});
