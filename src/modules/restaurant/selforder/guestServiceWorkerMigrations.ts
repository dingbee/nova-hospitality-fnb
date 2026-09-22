/**
 * One-time guest service-worker migration steps. Kept out of
 * GuestServiceWorker.tsx (a component file, subject to
 * react-refresh/only-export-components) so this plain logic stays directly
 * unit-testable without rendering anything.
 */

/** The runtime-caching cache name a previous, now-removed navigateFallback/
 * NetworkFirst navigation strategy stored guest page shells under (see
 * vite.config.ts). Nothing in the current service worker reads or writes
 * it, but a guest device that installed an older worker before this fix
 * may still be holding it in Cache Storage — an explicit, one-time,
 * narrowly-scoped migration cleanup rather than a blanket "clear all site
 * data" (which would also blow away this same cache's future replacement,
 * or precached static assets, on every load). */
export const OBSOLETE_GUEST_PAGES_CACHE = "lexibite-guest-pages-v3";

/** Resolves rather than rejects on every path — Cache Storage being
 * unavailable, or the delete itself failing, must never block guest
 * ordering. */
export async function cleanupObsoleteGuestPagesCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.delete(OBSOLETE_GUEST_PAGES_CACHE);
  } catch {
    // Best-effort only.
  }
}
