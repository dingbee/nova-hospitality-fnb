import { createFileRoute, Outlet } from "@tanstack/react-router";
import { NovaShell } from "@/components/shell/NovaShell";
import { ComingSoon } from "@/components/os/ComingSoon";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ name: "robots", content: "noindex,nofollow" }] }),
  component: () => (
    <NovaShell>
      <Outlet />
    </NovaShell>
  ),
  errorComponent: ({ error }) => (
    <NovaShell>
      <ComingSoon title="Something went wrong" description={error.message} />
    </NovaShell>
  ),
  notFoundComponent: () => (
    <NovaShell>
      <ComingSoon title="Not found" description="This screen does not exist." />
    </NovaShell>
  ),
});
