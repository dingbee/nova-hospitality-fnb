import { createFileRoute } from "@tanstack/react-router";
import { StaffAccessGateway } from "@/modules/restaurant/core/ui/StaffAccessGateway";
import { ComingSoon } from "@/components/os/ComingSoon";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ name: "robots", content: "noindex,nofollow" }] }),
  component: StaffAccessGateway,
  errorComponent: ({ error }) => (
    <div className="min-h-screen bg-background p-6">
      <ComingSoon title="Something went wrong" description={error.message} />
    </div>
  ),
  notFoundComponent: () => (
    <div className="min-h-screen bg-background p-6">
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl text-foreground">Page not found</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The requested screen does not exist in this version of LexiBite.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Check the address or use the navigation to continue.
          </p>
        </div>
      </div>
    </div>
  ),
});
