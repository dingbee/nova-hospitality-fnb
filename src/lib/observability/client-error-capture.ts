/**
 * ME-16 remediation (ME16-01) — global browser error capture.
 *
 * Previously there was no `window.onerror`/`unhandledrejection` handler
 * anywhere: an uncaught client exception outside a route's error boundary
 * (e.g. thrown from an event handler, a timer, or a rejected promise never
 * awaited) left no trace at all.
 *
 * This only adds structured `console.error` capture, tagged with a
 * reference ID, so a developer with the affected device/browser devtools
 * open can find and correlate the failure. It deliberately does NOT ship
 * events to a remote endpoint or a new error-reporting vendor (none exists
 * in this repo, and ME-16 does not evidence that a new vendor is strictly
 * necessary) and does NOT surface a toast for every uncaught error, to
 * avoid introducing UI noise for benign third-party rejections — it is a
 * diagnostic capture layer, not a new user-facing pipeline.
 */

let installed = false;

function safeStringify(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const requestId = crypto.randomUUID();
    console.error(
      `[client:error] reference=${requestId}`,
      safeStringify({
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
      }),
      event.error ?? event.message,
    );
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const requestId = crypto.randomUUID();
    const reason = event.reason as unknown;
    console.error(
      `[client:unhandledrejection] reference=${requestId}`,
      safeStringify({
        message: reason instanceof Error ? reason.message : String(reason),
        route: window.location.pathname,
        timestamp: new Date().toISOString(),
      }),
      reason,
    );
  });
}
