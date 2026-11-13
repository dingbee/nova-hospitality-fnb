import { createFileRoute } from "@tanstack/react-router";
import { StaffAccessSetupPanel } from "@/modules/restaurant/core/ui/StaffAccessSetupPanel";
import { StaffPanel } from "@/modules/restaurant/core/ui/StaffPanel";

export const Route = createFileRoute("/_authenticated/admin/restaurant/staff")({
  head: () => ({
    meta: [
      { title: "Staff & Roles — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Manage team members, restaurant roles, property scope, stations and POS PINs.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: StaffManagementPage,
});

function StaffManagementPage() {
  return (
    <>
      <StaffPanel />
      <StaffAccessSetupPanel />
    </>
  );
}
