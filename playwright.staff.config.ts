import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * P09 final certification cycle — real-browser certification of Staff
 * Panel, Multi-Location Command and Menu/Pricing, signed in for real as
 * two different property-scoped roles, against a disposable Postgres +
 * PostgREST + minimal Auth stub this CI job creates and destroys (see
 * e2e-auth/support/ — a real disposable Supabase project was evaluated
 * first and is blocked by this account's free-tier project limit; the
 * local appliance's own real gateway was evaluated second and found to
 * be missing the /auth/v1/user route _authenticated.tsx's beforeLoad
 * needs, a separate pre-existing gap outside P09's own scope to fix).
 * Real PostgREST enforces the real RLS policies this closure's own
 * migrations wrote — nothing about authorization is reimplemented here.
 */
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const chromiumExecutablePath = existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined;
const PORT = Number(process.env.APP_HARNESS_PORT ?? 4320);

export default defineConfig({
  // A separate top-level directory, not nested under e2e/ or e2e-auth/ —
  // both of those already have their own Playwright config whose testDir
  // matches recursively; nesting here would make this suite get picked up
  // by the WRONG config too (see the two regressions this exact mistake
  // already caused earlier in this closure, now fixed).
  testDir: "./e2e-staff",
  fullyParallel: false,
  workers: 1,
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
      VITE_NOVA_RUNTIME_MODE: process.env.VITE_NOVA_RUNTIME_MODE ?? "hosted",
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "https://localhost:8443",
      VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "nova-local-anon",
      SUPABASE_URL: process.env.SUPABASE_URL ?? "https://localhost:8443",
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? "nova-local-anon",
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
