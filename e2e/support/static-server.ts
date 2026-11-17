/**
 * Minimal static file server for the P10 real-browser harness — serves the
 * esbuild-built bundle to Playwright. No new HTTP-server dependency: this
 * repo already avoids adding a package where a few lines over Node's own
 * `node:http` solve the requirement (see db.ts's equivalent rationale for
 * not adding idb/Dexie).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", ".generated");
const guestRoot = join(root, "guest");
const port = Number(process.env.HARNESS_PORT ?? 4310);

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

/** A stub guest table page. The REAL app's TanStack Start SSR route isn't
 * exercised here — this environment has no live Supabase backend to serve
 * it against (see build-harness.ts's own disclosed scope for the offline
 * module) — but service-worker navigation-interception behavior is
 * identical either way: nothing about the defect this harness certifies
 * (a NetworkFirst navigateFallback substituting the wrong document for a
 * slow/failed navigation) depends on what the real document contains. */
const GUEST_ORDER_PAGE = "<!doctype html><html><body>GUEST-ORDER-PAGE-OK</body></html>";

// Two kinds of independent guest-order scope, each serving its own service
// worker next to its own pages — exactly how production serves sw.js next
// to /order/* (see vite.config.ts's scope: "/order"). "/order/" carries the
// REAL, fixed, exported guestServiceWorkerOptions build. "/order-stale-w<N>/"
// (N = the Playwright worker index that owns it — see
// guest-service-worker-realbrowser.spec.ts) carries a per-worker copy of a
// fixture reproducing the config this repo shipped before this fix
// (navigateFallback + NetworkFirst navigation caching): the stale-worker-
// replacement test mutates its own copy's sw.js on disk to simulate a
// redeploy, and Playwright's projects (desktop/tablet/mobile) run that same
// test concurrently against this one shared static-server process, so a
// single shared "/order-stale/" directory would let one worker's in-
// progress redeploy simulation corrupt another's — each Playwright worker
// gets its own directory instead.
const FIXED_GUEST_SCOPE = { prefix: "/order/", assetDir: guestRoot };
const STALE_SCOPE_PATTERN = /^\/order-stale-w(\d+)\//;

createServer(async (req, res) => {
  const url = req.url ?? "/harness.html";

  const staleMatch = url.match(STALE_SCOPE_PATTERN);
  const scope = url.startsWith(FIXED_GUEST_SCOPE.prefix)
    ? FIXED_GUEST_SCOPE
    : staleMatch
      ? {
          prefix: `/order-stale-w${staleMatch[1]}/`,
          assetDir: join(guestRoot, `stale-w${staleMatch[1]}`),
        }
      : undefined;
  if (scope) {
    const relativePath = url.slice(scope.prefix.length);
    // Only the worker script, its workbox runtime chunk, and (for the
    // stale fixture) its own precached offline.html are real files on
    // disk — everything else under this scope is a stub guest table page.
    if (/^(sw\.js|workbox-[\w.-]+\.js|offline\.html)$/.test(relativePath)) {
      const filePath = join(scope.assetDir, relativePath);
      try {
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(GUEST_ORDER_PAGE);
    return;
  }

  const path = url === "/" ? "/harness.html" : url;
  const filePath = join(root, path);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    await stat(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => {
  console.log(`P10 harness static server listening on :${port}`);
});
