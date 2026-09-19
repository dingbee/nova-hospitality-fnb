import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";
// Side-effect only: augments vite's `UserConfig` type with vitest's `test`
// option, so the `test` key below typechecks against the wrapped
// defineConfig's vite-derived UserConfig type.
import "vitest/config";

/**
 * LexiBite — Restaurant & Bar OS.
 *
 * The same application serves Lovable/Cloudflare and Vercel deployments.
 * The deployment target is selected from the host environment so the
 * Lovable sandbox remains unchanged while Vercel receives Nitro's Vercel
 * build output instead of the default Cloudflare Worker artifact.
 */
const isVercel = Boolean(process.env.VERCEL);

export default defineConfig({
  // Lovable's wrapper already supplies TanStack Start, React, Tailwind,
  // path aliases and Nitro. Explicitly pin the Nitro target on Vercel.
  nitro: isVercel ? { preset: "vercel" } : true,

  tanstackStart: {
    // Keep the canonical server entry used by the application's SSR/error
    // boundary on every deployment target.
    server: { entry: "server" },
  },

  test: {
    // e2e/ holds Playwright specs (run via `npx playwright test`), not
    // vitest tests — without this, vitest's default *.spec.ts glob picks
    // them up too and fails, since they use @playwright/test's `test`,
    // not vitest's.
    exclude: ["**/node_modules/**", "e2e/**"],
  },

  plugins: [
    VitePWA({
      manifest: false,
      registerType: "prompt",
      injectRegister: null,
      filename: "sw.js",
      // Static assets are emitted into the active Nitro public directory.
      // Lovable/Cloudflare uses .output/public; the Vercel Nitro preset
      // remaps the production artifact to Vercel's output contract.
      outDir: ".output/public",
      scope: "/order",
      devOptions: { enabled: false },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,jpg,jpeg,svg,webp,woff,woff2,json}"],
        navigateFallback: "/offline.html",
        navigateFallbackDenylist: [/^\/auth\/v1/, /^\/rest\//, /^\/nova\//, /^\/_serverFn/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Server functions are transactional and must remain network-only.
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.mode === "navigate" && !url.pathname.startsWith("/_serverFn"),
            handler: "NetworkFirst",
            options: {
              cacheName: "nova-pages",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
