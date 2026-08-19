// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      // Use existing site.webmanifest (do not regenerate or override branding).
      manifest: false,
      registerType: "prompt",
      injectRegister: null,
      filename: "sw.js",
      devOptions: { enabled: false },
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,jpg,jpeg,svg,webp,avif,woff,woff2,json}",
        ],
        navigateFallback: "/offline.html",
        navigateFallbackDenylist: [
          /^\/~oauth/,
          /^\/api\//,
          /^\/_serverFn/,
          /^\/lovable\//,
          /^\/email\//,
          /^\/sitemap.*\.xml$/,
          /^\/robots\.txt$/,
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          // Page navigations — NetworkFirst so fresh content wins online,
          // cached HTML serves offline, /offline.html as the final fallback.
          {
            urlPattern: ({ request, url }) =>
              request.mode === "navigate" &&
              !url.pathname.startsWith("/~oauth") &&
              !url.pathname.startsWith("/api/") &&
              !url.pathname.startsWith("/_serverFn") &&
              !url.pathname.startsWith("/lovable/") &&
              !url.pathname.startsWith("/email/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "mtoni-pages",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // TanStack server functions / dynamic JSON — NetworkFirst.
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/_serverFn"),
            handler: "NetworkFirst",
            options: {
              cacheName: "mtoni-server-fn",
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Google Fonts stylesheet — SWR.
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          // Google Fonts files — CacheFirst, long-lived.
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Lovable CDN-hosted assets (images, logos).
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/__l5e/assets-v1/"),
            handler: "CacheFirst",
            options: {
              cacheName: "mtoni-cdn-assets",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Same-origin static assets (icons, hashed JS/CSS not covered by precache).
          {
            urlPattern: ({ request, sameOrigin }) =>
              sameOrigin &&
              ["image", "font", "style", "script"].includes(request.destination),
            handler: "CacheFirst",
            options: {
              cacheName: "mtoni-static",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
