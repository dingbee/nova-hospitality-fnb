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
      // The Cloudflare/Nitro build for this app serves static assets from
      // .output/public (see .output/server/wrangler.json's assets.directory)
      // — not the plain "dist" vite-plugin-pwa defaults to, which this
      // build never deploys. Without this, sw.js/workbox-*.js were written
      // to a directory nothing ever serves, so the service worker 404'd in
      // every real deployment regardless of client-side registration code.
      outDir: ".output/public",
      // Scoped to the guest ordering PWA only — matches
      // lexibite-guest.webmanifest's own "scope" exactly (no trailing
      // slash: service worker scope matching is a literal string prefix,
      // so "/order/" would exclude the manifest's own start_url, "/order",
      // from the worker's control). A shared device that has both scanned
      // a guest QR and signed in to the staff terminal must never have the
      // guest service worker intercept an admin navigation, serve the
      // guest offline page, or otherwise reach outside the guest
      // experience it was installed for.
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
        // Server functions (/_serverFn) are the ONLY path through which
        // prices, menu state, stock, cart truth, order status, payment
        // status and guest session state ever reach the client — every one
        // of them is a POST to a shared URL differentiated only by request
        // body, which the Cache Storage API cannot key on. A NetworkFirst
        // rule here previously risked serving a cached response for a
        // DIFFERENT query (wrong order/price/stock) whenever the network
        // request took longer than its timeout. Deliberately no runtime
        // caching rule for /_serverFn: Workbox's default for anything with
        // no matching rule is NetworkOnly, so these always hit the server —
        // "dynamic transactional data must remain server-authoritative."
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
