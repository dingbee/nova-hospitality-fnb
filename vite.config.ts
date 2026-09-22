import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";
import "vitest/config";

/**
 * LexiBite — Restaurant & Bar OS.
 *
 * Lovable/Cloudflare keeps the wrapper's normal Nitro target. Vercel uses
 * Nitro's first-party Vercel preset so the same repository emits a native
 * Vercel deployment artifact.
 */
const isVercel = Boolean(process.env.VERCEL);
const publicOutDir = isVercel ? ".vercel/output/static" : ".output/public";

/**
 * Exported (not just inlined below) so vite.config.test.ts can assert on
 * this exact shape directly, rather than trying to reverse-engineer it out
 * of VitePWA()'s opaque returned Plugin array — the guest-portal offline
 * regression this guards against is entirely a configuration-shape defect
 * (see the inline comments below), so asserting on the shape itself is the
 * right level for the regression test.
 */
export const guestServiceWorkerOptions = {
  manifest: false as const,
  // Guest PWA updates must not get stranded behind an old service worker.
  // The guest route is safe to reload because the basket/order state is
  // held by the application and order submission is idempotent.
  registerType: "autoUpdate" as const,
  injectRegister: null,
  filename: "sw.js",
  outDir: publicOutDir,
  scope: "/order",
  devOptions: { enabled: false },
  workbox: {
    globPatterns: ["**/*.{js,css,ico,png,jpg,jpeg,svg,webp,woff,woff2,json}"],
    // vite-plugin-pwa defaults `workbox.navigateFallback` to "index.html"
    // (node_modules/vite-plugin-pwa/dist/index.js's `defaultWorkbox`,
    // merged in via `Object.assign({}, defaultWorkbox, options.workbox)`)
    // whenever the key is absent from this object — simply not mentioning
    // `navigateFallback` here does NOT disable it, it silently re-enables
    // a navigation fallback (confirmed by building and inspecting the
    // generated sw.js, which otherwise still registered a NavigationRoute
    // bound to "index.html" — a file this SW does not even precache,
    // since `globPatterns` below has no `html` extension, so that route
    // would resolve to a precache miss for every navigation). Must stay
    // explicitly `undefined` to actually disable it.
    navigateFallback: undefined,
    // Guest ordering is ONLINE_REQUIRED / FORBIDDEN_OFFLINE (see this
    // repo's CLAUDE.md): navigation to /order/* must never be answered by
    // this service worker. There is deliberately no `navigateFallback` and
    // no runtime-caching route matching `request.mode === "navigate"` — a
    // previous NetworkFirst rule with a 12s timeout raced every guest page
    // load against a fixed clock and fell back to a generic /offline.html
    // the instant Wi-Fi roaming, a captive portal, or an ordinary slow
    // network made that race lose, even though the server was perfectly
    // reachable. With no route registered for navigation requests, Workbox
    // never calls `event.respondWith()` for them: the browser makes the
    // real network request directly, uncontrolled by any cache or
    // fallback, exactly like a page with no service worker at all. Once
    // the guest shell has loaded, the app's own data layer (every guest
    // query/mutation uses `networkMode: "always"`, see order.$tableId.tsx)
    // already provides the real retry/error UI for a transient failure or
    // a genuine outage — this SW must not shadow that with a second,
    // worse failure mode.
    cleanupOutdatedCaches: true,
    // Take the newly deployed guest worker immediately so a stale
    // worker's fetch handling (e.g. the old navigateFallback behavior
    // above) cannot keep controlling a guest's device indefinitely after a
    // deployment. This only changes which worker answers future network
    // requests — it does not by itself reload the page (see
    // GuestServiceWorker.tsx for why that distinction matters for an
    // in-progress, unsaved cart).
    clientsClaim: true,
    skipWaiting: true,
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  },
};

export default defineConfig({
  // The wrapper owns TanStack Start/Nitro integration. Do not disable its
  // Nitro plugin and replace it with a second Vite plugin: that can leave
  // Vercel with no valid server output in CI.
  nitro: isVercel ? { preset: "vercel" } : true,

  tanstackStart: {
    server: { entry: "server" },
  },

  // @lovable.dev/vite-tanstack-config's `defineConfig` only reads a fixed
  // set of top-level fields (define/environments/css/resolve/optimizeDeps/
  // plugins) — a bare `test` key here is silently dropped at runtime (and
  // rejected by its own types, which don't declare `test` at all; see the
  // pre-existing "'test' does not exist" tsc error this file already had).
  // `vite` is its documented escape hatch: anything here is merged into
  // the real Vite config via `mergeConfig`, which is what actually reaches
  // both Vite and Vitest. Without this, vitest's own defaults
  // (`**/node_modules/**`, `**/.git/**` — nothing else) let it collect
  // e2e/*.spec.ts as if they were vitest tests, which fails immediately
  // since they're Playwright specs.
  vite: {
    test: {
      exclude: ["**/node_modules/**", "e2e/**"],
    },
  },

  plugins: [VitePWA(guestServiceWorkerOptions)],
});
