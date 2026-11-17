/**
 * Real-browser certification harness build step for the guest ordering
 * service worker — a sibling to build-harness.ts's offline-module harness,
 * covering a different part of the same P10/guest-portal reliability
 * surface: the SW config regression fixed alongside this pass (see
 * vite.config.ts's `guestServiceWorkerOptions` doc comment).
 *
 * Runs the REAL `workbox-build` `generateSW` — the exact engine
 * vite-plugin-pwa delegates to — against the REAL exported
 * `guestServiceWorkerOptions.workbox` from vite.config.ts, merged the same
 * way vite-plugin-pwa merges it (`Object.assign({}, defaultWorkbox,
 * options.workbox)`, see node_modules/vite-plugin-pwa/dist/index.js) so a
 * regression in that exported config is caught by an actual generated
 * service worker running in real Chromium, not just the config-shape
 * assertions in vite.config.test.ts.
 *
 * Also builds a second, deliberately old-shaped service worker
 * (`stale/sw.js`) reproducing the pre-fix config (navigateFallback +
 * NetworkFirst navigation caching) for the stale-worker-replacement test —
 * this is the config this repository previously shipped, kept here only
 * as a fixture for proving the new worker replaces it, not as production
 * config.
 */
import { generateSW } from "workbox-build";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export default async function buildGuestSwHarness() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const outDir = join(repoRoot, "e2e", ".generated", "guest");
  const staleDir = join(outDir, "stale");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(staleDir, { recursive: true });

  // Dummy static assets so each build's real `globPatterns` has something
  // to precache — content is irrelevant; only the generated route/fallback
  // behavior is under test.
  writeFileSync(join(outDir, "dummy.js"), "// dummy asset\n");
  writeFileSync(join(outDir, "dummy.css"), "/* dummy */\n");
  writeFileSync(
    join(staleDir, "offline.html"),
    "<!doctype html><html><body>STALE-OFFLINE-PAGE</body></html>",
  );

  const { guestServiceWorkerOptions } = (await import(
    pathToFileURL(join(repoRoot, "vite.config.ts")).href
  )) as { guestServiceWorkerOptions: { workbox: Record<string, unknown> } };

  await generateSW({
    ...guestServiceWorkerOptions.workbox,
    swDest: join(outDir, "sw.js"),
    globDirectory: outDir,
  } as Parameters<typeof generateSW>[0]);

  // The pre-fix shape this repository actually shipped (see this task's PR
  // description) — reconstructed here only as a fixture, never imported
  // from production source (it no longer exists there).
  await generateSW({
    globDirectory: staleDir,
    globPatterns: ["**/*.{js,css,html}"],
    swDest: join(staleDir, "sw.js"),
    navigateFallback: "offline.html",
    navigateFallbackDenylist: [/^\/_serverFn/],
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
    runtimeCaching: [
      {
        urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
        handler: "NetworkFirst",
        options: {
          cacheName: "stale-guest-pages",
          networkTimeoutSeconds: 1,
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  } as Parameters<typeof generateSW>[0]);

  console.log(`Real-browser guest service worker harness built at ${outDir}`);
}
