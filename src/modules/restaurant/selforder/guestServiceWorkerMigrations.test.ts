/**
 * `cleanupObsoleteGuestPagesCache` is the explicit, one-time service-worker
 * migration step GuestServiceWorker.tsx's fix requires: a guest device
 * that installed the previous (buggy) worker may still be holding stale
 * SSR'd page shells under the now-removed NetworkFirst navigation cache
 * ("lexibite-guest-pages-v3", see vite.config.ts). Nothing in the current
 * worker reads that cache any more, but it must still be explicitly
 * deleted rather than left to linger indefinitely in Cache Storage.
 *
 * This is a plain-function unit test (no React rendering) — this repo has
 * no component-testing infrastructure (jsdom/@testing-library) installed,
 * so the React-hook wiring in GuestServiceWorker.tsx (onNeedReload
 * surfacing the refresh banner instead of an unprompted reload) is not
 * covered by an automated test here; see that file's own doc comment,
 * which documents the exact vite-plugin-pwa source lines proving the
 * behavior, as the next-best evidence available without adding new test
 * tooling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OBSOLETE_GUEST_PAGES_CACHE,
  cleanupObsoleteGuestPagesCache,
} from "./guestServiceWorkerMigrations";

describe("cleanupObsoleteGuestPagesCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the obsolete guest-pages cache by name", async () => {
    const deleteFn = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: deleteFn });

    await cleanupObsoleteGuestPagesCache();

    expect(deleteFn).toHaveBeenCalledExactlyOnceWith(OBSOLETE_GUEST_PAGES_CACHE);
  });

  it("never throws when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    await expect(cleanupObsoleteGuestPagesCache()).resolves.toBeUndefined();
  });

  it("never throws when the delete call itself rejects", async () => {
    vi.stubGlobal("caches", {
      delete: vi.fn().mockRejectedValue(new Error("Cache Storage unavailable")),
    });
    await expect(cleanupObsoleteGuestPagesCache()).resolves.toBeUndefined();
  });
});
