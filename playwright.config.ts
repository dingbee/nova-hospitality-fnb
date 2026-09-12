import { defineConfig, devices } from "@playwright/test";

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
          executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
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
          executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
          args: ["--no-sandbox"],
        },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
          args: ["--no-sandbox"],
        },
      },
    },
  ],
});
