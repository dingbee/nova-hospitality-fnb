import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import appCss from "../styles.css?url";
import { Toaster } from "@/components/ui/sonner";
import { PRODUCT } from "@/config/product";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false } },
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: `${PRODUCT.name} — ${PRODUCT.tagline}` },
      { name: "description", content: `${PRODUCT.tagline}: point of sale, kitchen, inventory, procurement and costing for restaurants and bars.` },
      { name: "robots", content: "noindex,nofollow" },
      { name: "theme-color", content: "#101418" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/nova-terminal.webmanifest" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-5xl font-bold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This screen does not exist.</p>
        <Link to="/admin/restaurant" className="mt-6 inline-flex rounded bg-primary px-4 py-2 text-sm text-primary-foreground">
          Go to the OS
        </Link>
      </div>
    </div>
  ),
});

function RootComponent() {
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
