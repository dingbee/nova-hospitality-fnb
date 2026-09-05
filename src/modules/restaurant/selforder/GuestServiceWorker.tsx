/**
 * Registers the guest ordering PWA's service worker (vite.config.ts's
 * `injectRegister: null` deliberately leaves this to the app, so the
 * service worker is never active on the staff/admin terminal — only the
 * guest ordering routes mount this).
 *
 * `registerType: "prompt"` in vite.config.ts means an updated service
 * worker installs but waits rather than silently taking over an open
 * order — the spec's "safe update handling" requires we actually ask
 * before swapping it in, never auto-reload a guest mid-order. This is
 * that prompt: a small top banner (never the bottom, where the cart bar
 * and checkout CTA live) offering an explicit refresh.
 */
import { useRegisterSW } from "virtual:pwa-register/react";

export function GuestServiceWorker() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="pt-safe fixed inset-x-0 top-0 z-[60] flex items-center justify-between gap-3 bg-foreground px-4 py-2.5 text-background shadow-md">
      <p className="text-sm">A new version is available.</p>
      <button
        type="button"
        onClick={() => updateServiceWorker(true)}
        className="h-9 shrink-0 rounded-md bg-background px-3 text-sm font-medium text-foreground"
      >
        Refresh
      </button>
    </div>
  );
}
