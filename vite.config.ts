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

export default defineConfig({
  // The wrapper owns TanStack Start/Nitro integration. Do not disable its
  // Nitro plugin and replace it with a second Vite plugin: that can leave
  // Vercel with no valid server output in CI.
  nitro: isVercel ? { preset: "vercel" } : true,

  tanstackStart: {
    server: { entry: "server" },
  },

  test: {
    exclude: ["**/node_modules/**", "e2e/**"],
  },

  plugins: [
    VitePWA({
      manifest: false,
      registerType: "prompt",
      injectRegister: null,
      filename: "sw.js",
      outDir: publicOutDir,
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
