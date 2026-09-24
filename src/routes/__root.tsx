import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import appCss from "../styles.css?url";
import shellCss from "../components/shell/NovaShell.css?url";
import { Toaster } from "@/components/ui/sonner";
import { PRODUCT } from "@/config/product";
import { installGlobalErrorCapture } from "@/lib/observability/client-error-capture";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false } },
});

const ASSET_RECOVERY_KEY = "lexibite:asset-recovery";
const ASSET_RECOVERY_COOLDOWN_MS = 60_000;

async function recoverStaleClientAssets() {
  if (typeof window === "undefined") return;

  const isOrderRoute = window.location.pathname === "/order" || window.location.pathname.startsWith("/order/");
  if (isOrderRoute) return;

  const probe = document.createElement("ul");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.innerHTML = "<li><a href=\"#\">asset-check</a></li>";
  document.body.appendChild(probe);

  const li = probe.firstElementChild as HTMLElement | null;
  const link = probe.querySelector("a") as HTMLAnchorElement | null;
  const cssLoaded =
    li != null &&
    link != null &&
    getComputedStyle(li).listStyleType === "none" &&
    getComputedStyle(link).textDecorationLine === "none";

  probe.remove();

  if (cssLoaded) return;

  const now = Date.now();
  const lastRecovery = Number(sessionStorage.getItem(ASSET_RECOVERY_KEY) ?? "0");
  if (now - lastRecovery < ASSET_RECOVERY_COOLDOWN_MS) return;

  sessionStorage.setItem(ASSET_RECOVERY_KEY, String(now));

  try {
    const registrations = await navigator.serviceWorker?.getRegistrations();
    await Promise.all(
      (registrations ?? [])
        .filter((registration) => !registration.scope.endsWith("/order/"))
        .map((registration) => registration.unregister()),
    );
  } catch {
    // Recovery must still proceed if service-worker APIs are unavailable.
  }

  try {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
  } catch {
    // Cache access can be unavailable in restricted browser contexts.
  }

  // Force a fresh document request after clearing stale client assets.
  // Also strip the legacy recovery marker if the browser is already sitting
  // on a URL produced by the previous implementation.
  const url = new URL(window.location.href);
  if (url.searchParams.has("_lexibite_asset_recovery")) {
    url.searchParams.delete("_lexibite_asset_recovery");
    window.history.replaceState(window.history.state, "", url.toString());
  }
  window.location.reload();
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: `${PRODUCT.name} — ${PRODUCT.tagline}` },
      {
        name: "description",
        content: `${PRODUCT.tagline}: point of sale, kitchen, inventory, procurement and costing for restaurants and bars.`,
      },
      { name: "robots", content: "noindex,nofollow" },
      { name: "theme-color", content: "#2A7C13" },
      { name: "application-name", content: PRODUCT.name },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: shellCss },
      { rel: "icon", href: "/lexibite-favicon-v2.ico", sizes: "any" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-5xl font-bold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This screen does not exist.</p>
        <Link
          to="/admin/restaurant"
          className="mt-6 inline-flex rounded bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Go to the OS
        </Link>
      </div>
    </div>
  ),
});

function RootComponent() {
  useEffect(() => {
    installGlobalErrorCapture();
    void recoverStaleClientAssets();
  }, []);

  return (
    <html lang="en" data-os-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Outlet />
          <Toaster />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}