/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { SectionCard } from "@/components/os/SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { inviteStaffUser, listStaffUsers } from "@/lib/staff.functions";
import { RESTAURANT_ROLES } from "@/modules/restaurant/core/contracts";
import { RESTAURANT_ROLE_LABELS } from "@/modules/restaurant/core/permissions";
import {
  getRestaurantWorkspaceFn,
  listRestaurantMembersFn,
  removeRestaurantMemberFn,
  upsertRestaurantMemberFn,
} from "@/modules/restaurant/core/tenancy.functions";

export function TeamPanel({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const membersFn = useServerFn(listRestaurantMembersFn);
  const staffFn = useServerFn(listStaffUsers);
  const workspaceFn = useServerFn(getRestaurantWorkspaceFn);
  const addFn = useServerFn(upsertRestaurantMemberFn);
  const removeFn = useServerFn(removeRestaurantMemberFn);
  const inviteFn = useServerFn(inviteStaffUser);

  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [propertyId, setPropertyId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");

  const members = useQuery({
    queryKey: ["restaurant.members", tenantId],
    queryFn: () => membersFn({ data: { tenantId } }),
  });
  const staff = useQuery({
    queryKey: ["staff.users"],
    queryFn: () => staffFn(),
    enabled: canManage,
  });
  const workspace = useQuery({
    queryKey: ["restaurant.workspace.forTeam", tenantId],
    queryFn: () => workspaceFn({ data: { tenantId } }),
    enabled: canManage,
  });
  const properties = ((workspace.data as any)?.properties ?? []) as { id: string; name: string }[];
  const propertyById = new Map(properties.map((p) => [p.id, p.name]));

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["restaurant.members", tenantId] });

  const add = useAdminMutation({
    mutationFn: () =>
      addFn({
        data: { tenantId, userId, role: role as any, propertyId: propertyId || undefined },
      }),
    successMessage: "Role granted",
    onSuccess: () => {
      setUserId("");
      setPropertyId("");
      invalidate();
    },
  });
  const remove = useAdminMutation({
    mutationFn: (memberId: string) => removeFn({ data: { tenantId, memberId } }),
    successMessage: "Role removed",
    onSuccess: invalidate,
  });
  const invite = useAdminMutation({
    mutationFn: () => inviteFn({ data: { email: inviteEmail, fullName: inviteName || undefined } }),
    successMessage:
      "Account created. If email delivery isn't configured for this project, share sign-in access with them directly.",
    onSuccess: (result: any) => {
      setInviteEmail("");
      setInviteName("");
      setUserId(result?.userId ?? "");
      void qc.invalidateQueries({ queryKey: ["staff.users"] });
    },
  });

  const staffById = new Map((staff.data ?? []).map((u: any) => [u.user_id, u]));
  const rows = members.data ?? [];

  return (
    <SectionCard
      title="Team & roles"
      description="Restaurant roles are tenant-scoped and decide who may price, purchase, receive, void or close the day."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tenant roles assigned yet — only platform administrators can operate this tenant.
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((m: any) => {
            const u = staffById.get(m.user_id) as any;
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <span className="font-medium">{u?.full_name ?? u?.email ?? m.user_id}</span>
                  <p className="text-xs text-muted-foreground">
                    {RESTAURANT_ROLE_LABELS[m.role as keyof typeof RESTAURANT_ROLE_LABELS] ??
                      m.role}
                    {" · "}
                    {m.property_id
                      ? (propertyById.get(m.property_id) ?? "One property")
                      : "Every property"}
                    {u?.email ? ` · ${u.email}` : ""}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(m.id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <div className="mt-4 space-y-1 rounded-md border p-3">
          <p className="text-sm font-medium">Invite a new person</p>
          <p className="text-xs text-muted-foreground">
            No account for them yet? Create one here, then grant their restaurant role below.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_2fr_auto]">
            <Input
              type="email"
              placeholder="Email address"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <Input
              placeholder="Full name (optional)"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!inviteEmail || invite.isPending}
              onClick={() => invite.mutate(undefined)}
            >
              Create account
            </Button>
          </div>
        </div>
      ) : null}

      {canManage ? (
        <div className="mt-4 space-y-2">
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Select staff member…</option>
              {(staff.data ?? []).map((u: any) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.full_name ?? u.email ?? u.user_id}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {RESTAURANT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {RESTAURANT_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-transparent px-2 py-2 text-sm"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              <option value="">Every property (tenant-wide)</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!userId || add.isPending}
              onClick={() => add.mutate(undefined)}
            >
              Grant role
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pick a property to scope this role to it only — the person will have no access to the
            tenant&apos;s other properties. Leave "Every property" for oversight roles like owner or
            general manager.
          </p>
        </div>
      ) : null}
    </SectionCard>
  );
}
