import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * P09 — real-browser certification of the staff sign-in screen (`/auth`),
 * the front door every admin/enterprise workflow this closure touched sits
 * behind. Deliberately separate from playwright.config.ts (the P10 offline
 * module's static-bundle harness): that config's `webServer` serves a
 * purpose-built static page, not the actual TanStack Start app, so it
 * cannot reach a real route. This config instead runs the real `vite dev`
 * server and lets Playwright navigate the real app.
 *
 * `/auth` needs no mocking and touches no backend at all: `createClient()`
 * only throws if the two Supabase env vars are entirely absent (never
 * validates reachability at construction), and `AuthPage`'s own
 * `supabase.auth.getSession()` resolves from local storage without a
 * network call for a fresh browser context with no stored session — see
 * src/integrations/supabase/client.ts and src/routes/auth.tsx. The dummy
 * values below match this repo's own `.env.example` local-appliance
 * defaults, not a real project — nothing here can reach or affect
 * production data.
 */
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const chromiumExecutablePath = existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined;
const PORT = Number(process.env.APP_HARNESS_PORT ?? 4320);

export default defineConfig({
  testDir: "./e2e/app",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: `bun run dev -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_NOVA_RUNTIME_MODE: "hosted",
      VITE_SUPABASE_URL: "https://localhost:8443",
      VITE_SUPABASE_PUBLISHABLE_KEY: "nova-local-anon",
    },
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
  ],
});
