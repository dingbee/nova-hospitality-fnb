import { createFileRoute } from "@tanstack/react-router";
import { StaffPanel } from "@/modules/restaurant/core/ui/StaffPanel";

export const Route = createFileRoute("/_authenticated/admin/restaurant/staff")({
  head: () => ({
    meta: [
      { title: "Staff & Roles — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Manage who has access to this restaurant and what they can do.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: StaffPanel,
});
