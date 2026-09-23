import { createRouter, useRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { routeTree } from "./routeTree.gen";
import { presentUserFacingError } from "@/lib/errors/present-error";

const STALE_CHUNK_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [^ ]+ failed/i;
const DYNAMIC_IMPORT_RECOVERY_KEY = "lexibite:dynamic-import-recovery";
const DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS = 30_000;

function recoverFromStaleDynamicImport(error: Error): boolean {
  if (typeof window === "undefined" || !STALE_CHUNK_ERROR.test(error.message)) {
    return false;
  }

  try {
    const lastRecovery = Number(
      window.sessionStorage.getItem(DYNAMIC_IMPORT_RECOVERY_KEY) ?? "0",
    );
    const now = Date.now();

    // Prevent a broken deployment or persistent client failure from causing
    // an infinite reload loop. A later manual refresh can retry recovery.
    if (now - lastRecovery < DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS) {
      return false;
    }

    window.sessionStorage.setItem(DYNAMIC_IMPORT_RECOVERY_KEY, String(now));

    // A route can retain an older application shell after a deployment. The
    // changed query string forces a fresh document/module resolution without
    // changing application routing, authentication, or persisted data.
    const url = new URL(window.location.href);
    url.searchParams.set("_lexibite_reload", String(now));
    window.location.replace(url.toString());
    return true;
  } catch {
    // Storage can be unavailable in restricted browser contexts. Keep the
    // normal error boundary usable rather than allowing recovery to throw.
    return false;
  }
}

function DefaultErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  // Recover automatically from the stale application-shell/chunk mismatch
  // that can occur immediately after a new production deployment.
  useEffect(() => {
    recoverFromStaleDynamicImport(error);
  }, [error]);

  // ME-16 remediation (ME16-03): a correlation reference is shown even in
  // production, without ever showing the raw message/stack there — the
  // DEV-only panel below still carries the full detail for local debugging.
  const presented = presentUserFacingError(
    error,
    "An unexpected error occurred. Please try again.",
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{presented.message}</p>
        {import.meta.env.DEV && error.message && (
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
