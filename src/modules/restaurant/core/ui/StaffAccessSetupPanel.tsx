import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SectionCard } from "@/components/os/SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { inviteStaffUser, listStaffUsers } from "@/lib/staff.functions";
import { ASSIGNABLE_RESTAURANT_ROLES } from "@/modules/restaurant/core/contracts";
import { RESTAURANT_ROLE_LABELS } from "@/modules/restaurant/core/permissions";
import {
  getRestaurantWorkspaceFn,
  listRestaurantMembersFn,
  upsertRestaurantMemberFn,
} from "@/modules/restaurant/core/tenancy.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

/**
 * Staff onboarding and initial role grants live alongside the staff directory.
 * This reuses the existing invitation and tenant-membership server functions.
 */
export function StaffAccessSetupPanel() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const canManage = Boolean(
    ws.data?.platformAdmin ||
      ws.data?.roles?.some((role) => role === "owner" || role === "general_manager"),
  );
  const qc = useQueryClient();

  const staffFn = useServerFn(listStaffUsers);
  const membersFn = useServerFn(listRestaurantMembersFn);
  const workspaceFn = useServerFn(getRestaurantWorkspaceFn);
  const inviteFn = useServerFn(inviteStaffUser);
  const grantFn = useServerFn(upsertRestaurantMemberFn);

  const staff = useQuery({
    queryKey: ["staff.users"],
    queryFn: () => staffFn(),
    enabled: Boolean(tenantId && canManage),
  });
  const members = useQuery({
    queryKey: ["restaurant.members", tenantId],
    queryFn: () => membersFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId && canManage),
  });
  const workspace = useQuery({
    queryKey: ["restaurant.workspace.forTeam", tenantId],
    queryFn: () => workspaceFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId && canManage),
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [propertyId, setPropertyId] = useState("");

  const invite = useAdminMutation({
    mutationFn: () =>
      inviteFn({ data: { email: inviteEmail, fullName: inviteName || undefined } }),
    successMessage:
      "Account created. If email delivery isn't configured for this project, share sign-in access with them directly.",
    onSuccess: (result: { userId?: string }) => {
      setInviteEmail("");
      setInviteName("");
      setUserId(result?.userId ?? "");
      void qc.invalidateQueries({ queryKey: ["staff.users"] });
    },
  });

  const grant = useAdminMutation({
    mutationFn: () =>
      grantFn({
        data: {
          tenantId: tenantId!,
          userId,
          role: role as never,
          propertyId: propertyId === "__tenant_wide__" ? null : propertyId,
        },
      }),
    successMessage: "Role granted.",
    onSuccess: () => {
      setUserId("");
      setPropertyId("");
      void qc.invalidateQueries({ queryKey: ["restaurant.members", tenantId] });
      void qc.invalidateQueries({ queryKey: ["staff.users"] });
    },
  });

  const properties = (workspace.data?.properties ?? []) as { id: string; name: string }[];
  const assignedIds = new Set((members.data ?? []).map((member: { user_id: string }) => member.user_id));
  const eligibleStaff = (staff.data ?? []).filter(
    (person: { user_id: string }) => !assignedIds.has(person.user_id),
  );

  if (!tenantId || !canManage) return null;

  return (
    <SectionCard
      title="Add team member"
      description="Create an account when needed, then grant the person a restaurant role and explicit property scope."
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <p className="text-sm font-medium">Create account</p>
          <div className="grid gap-2 sm:grid-cols-[2fr_2fr_auto]">
            <Input
              type="email"
              placeholder="Email address"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
            <Input
              placeholder="Full name (optional)"
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
            />
            <Button
              size="sm"
              disabled={!inviteEmail.trim() || invite.isPending}
              onClick={() => invite.mutate(undefined)}
            >
              Create account
            </Button>
          </div>
        </div>

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">Grant restaurant access</p>
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Select staff member…</option>
              {eligibleStaff.map((person: { user_id: string; full_name?: string | null; email?: string | null }) => (
                <option key={person.user_id} value={person.user_id}>
                  {person.full_name ?? person.email ?? person.user_id}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ASSIGNABLE_RESTAURANT_ROLES.map((item) => (
                <option key={item} value={item}>{RESTAURANT_ROLE_LABELS[item]}</option>
              ))}
            </select>
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={propertyId}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              <option value="">Choose property scope…</option>
              <option value="__tenant_wide__">Every property (tenant-wide)</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>{property.name}</option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!userId || !propertyId || grant.isPending}
              onClick={() => grant.mutate(undefined)}
            >
              Grant role
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Property scope is required. Select “Every property” explicitly only for authorised cross-property oversight roles.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
