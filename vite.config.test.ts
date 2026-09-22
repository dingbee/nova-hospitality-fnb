/**
 * Regression coverage for the guest-portal "offline" outage: the guest
 * ordering PWA's service worker (vite.config.ts's `guestServiceWorkerOptions`,
 * scoped to /order/* only — see GuestServiceWorker.tsx) previously shipped a
 * `navigateFallback: "/offline.html"` plus a NetworkFirst runtime-caching
 * rule matching every navigation request with a 12s timeout. That combination
 * converted an ordinary slow network, a transient Wi-Fi blip, or a stale
 * worker into the generic offline page for a guest whose device was, in
 * fact, online — even though guest ordering is explicitly ONLINE_REQUIRED /
 * FORBIDDEN_OFFLINE (see CLAUDE.md) and must never be given its own offline
 * capability.
 *
 * These assertions pin the fixed shape directly, so a future change cannot
 * silently reintroduce either mechanism.
 */
import { describe, expect, it } from "vitest";
import { guestServiceWorkerOptions } from "./vite.config";

describe("guestServiceWorkerOptions (guest PWA service worker)", () => {
  it("never intercepts navigation with a generic offline fallback page", () => {
    // Must be an *own key set to undefined*, not merely absent: vite-plugin-pwa
    // defaults workbox.navigateFallback to "index.html" via
    // `Object.assign({}, defaultWorkbox, options.workbox)` whenever the key is
    // missing from options.workbox — confirmed by building and inspecting the
    // generated sw.js, which otherwise still registered a NavigationRoute (see
    // node_modules/vite-plugin-pwa/dist/index.js's `defaultWorkbox`). Merely
    // omitting the key here silently re-enables it.
    expect("navigateFallback" in guestServiceWorkerOptions.workbox).toBe(true);
    expect(guestServiceWorkerOptions.workbox.navigateFallback).toBeUndefined();
    expect(
      (guestServiceWorkerOptions.workbox as Record<string, unknown>).navigateFallbackDenylist,
    ).toBeUndefined();
  });

  it("registers no runtime-caching route that matches navigation requests", () => {
    const runtimeCaching = (guestServiceWorkerOptions.workbox as Record<string, unknown>)
      .runtimeCaching as unknown[] | undefined;
    expect(runtimeCaching ?? []).toHaveLength(0);
  });

  it("still precaches static guest assets (JS/CSS/images/fonts)", () => {
    const patterns = guestServiceWorkerOptions.workbox.globPatterns.join(",");
    for (const ext of ["js", "css", "png", "svg", "woff2"]) {
      expect(patterns).toContain(ext);
    }
  });

  it("no longer precaches HTML (the removed offline.html was the only one)", () => {
    expect(guestServiceWorkerOptions.workbox.globPatterns.join(",")).not.toContain("html");
  });

  it("stays scoped to the guest ordering route only, never the staff/admin app", () => {
    expect(guestServiceWorkerOptions.scope).toBe("/order");
  });

  it("keeps a deterministic, explicit worker-replacement lifecycle so an old worker cannot linger", () => {
    expect(guestServiceWorkerOptions.workbox.skipWaiting).toBe(true);
    expect(guestServiceWorkerOptions.workbox.clientsClaim).toBe(true);
    expect(guestServiceWorkerOptions.workbox.cleanupOutdatedCaches).toBe(true);
    expect(guestServiceWorkerOptions.registerType).toBe("autoUpdate");
  });
});
