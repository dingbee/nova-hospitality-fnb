import { createFileRoute, redirect } from "@tanstack/react-router";

/** The appliance has no public site — the origin is the operations terminal. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/restaurant" });
  },
});
