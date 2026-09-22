/**
 * Registers the guest ordering PWA's service worker (vite.config.ts's
 * `injectRegister: null` deliberately leaves this to the app, so the
 * service worker is never active on the staff/admin terminal — only the
 * guest ordering routes mount this).
 *
 * vite.config.ts sets `registerType: "autoUpdate"` together with the
 * workbox `skipWaiting`/`clientsClaim` options, so a newly deployed
 * worker always takes over fetch handling immediately — an old worker
 * (with its own, possibly buggy, fetch behavior) must never be able to
 * keep controlling a guest's device indefinitely after a deployment.
 * BUT that is a decision about which *worker* answers future network
 * requests, not about when the *page* reloads: vite-plugin-pwa's "auto"
 * registration mode reloads the page itself the instant the new worker
 * activates (see node_modules/vite-plugin-pwa/dist/client/build/
 * register.js — the "activated" listener calls `onNeedReload?.() ??
 * window.location.reload()`, and `onNeedRefresh` is never invoked in
 * this mode at all), with no way to opt out short of supplying
 * `onNeedReload` ourselves. Left at its default, that is a silent,
 * unprompted full-page reload that can fire at any moment — including
 * mid-order, wiping a guest's in-progress basket, which lives only in
 * this route's React state and is never persisted until the order is
 * actually submitted (see order.$tableId.tsx's `cart` state and
 * selforder-recovery.ts, which only ever stores an order id/session
 * token/client-request id, never basket contents).
 *
 * Overriding `onNeedReload` to raise this banner instead — leaving the
 * actual reload to an explicit guest tap — is what makes the two
 * concerns independent: the new worker is already in control (so a
 * stale worker is never stuck serving guests), while swapping the
 * *running page* onto the new build stays the guest's own choice, never
 * a surprise mid-order.
 */
import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { cleanupObsoleteGuestPagesCache } from "./guestServiceWorkerMigrations";

export function GuestServiceWorker() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const { updateServiceWorker } = useRegisterSW({
    onNeedReload() {
      setNeedRefresh(true);
    },
  });

  useEffect(() => {
    void cleanupObsoleteGuestPagesCache();
  }, []);

  if (!needRefresh) return null;

  return (
    <div className="pt-safe fixed inset-x-0 top-0 z-[60] flex items-center justify-between gap-3 bg-foreground px-4 py-2.5 text-background shadow-md">
      <p className="text-sm">A new version is available.</p>
      <button
        type="button"
        onClick={() => {
          // The new worker is already active and controlling (autoUpdate +
          // skipWaiting/clientsClaim, above) — there is nothing left to
          // skip-wait, so `updateServiceWorker` is a deliberate no-op here.
          // Reloading is what actually swaps this tab onto the new build.
          void updateServiceWorker(true);
          window.location.reload();
        }}
        className="h-9 shrink-0 rounded-md bg-background px-3 text-sm font-medium text-foreground"
      >
        Refresh
      </button>
    </div>
  );
}
