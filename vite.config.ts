import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

/**
 * NOVA Hospitality F&B — Restaurant & Bar OS.
 *
 * The same bundle serves the hosted deployment and the on-premise appliance;
 * only the runtime target differs (see src/modules/runtime/runtime-config.ts).
 */
export default defineConfig({
  plugins: [
    VitePWA({
      manifest: false,
      registerType: "prompt",
      injectRegister: null,
      filename: "sw.js",
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
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "nova-pages",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/_serverFn"),
            handler: "NetworkFirst",
            options: {
              cacheName: "nova-server-fn",
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
