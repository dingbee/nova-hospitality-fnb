import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, MapPin, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import {
  listRestaurantMembersFn,
  listMemberStationAssignmentsFn,
  removeRestaurantMemberFn,
  setMemberStationAssignmentFn,
  upsertRestaurantMemberFn,
} from "../tenancy.functions";
import { ASSIGNABLE_RESTAURANT_ROLES } from "../contracts";
import { RESTAURANT_ROLE_LABELS } from "../permissions";

export function StaffPanel() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();

  const listFn = useServerFn(listRestaurantMembersFn);
  const members = useQuery({
    queryKey: ["restaurant.members", tenantId],
    queryFn: () => listFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  const upsertFn = useServerFn(upsertRestaurantMemberFn);
  const updateRole = useAdminMutation({
    mutationFn: (vars: {
      memberId: string;
      userId: string;
      role: string;
      propertyId: string | null;
    }) =>
      upsertFn({
        data: {
          tenantId: tenantId!,
          userId: vars.userId,
          role: vars.role as never,
          propertyId: vars.propertyId,
        },
      }),
    successMessage: "Role updated.",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.members", tenantId] }),
  });

  const stationScopeFn = useServerFn(listMemberStationAssignmentsFn);
  const setStationScopeFn = useServerFn(setMemberStationAssignmentFn);
  const [stationMemberId, setStationMemberId] = useState<string | null>(null);

  const stationScope = useQuery({
    queryKey: ["restaurant.member-stations", tenantId, stationMemberId],
    queryFn: () =>
      stationScopeFn({
        data: { tenantId: tenantId!, memberId: stationMemberId! },
      }),
    enabled: Boolean(tenantId && stationMemberId),
  });

  const setStation = useAdminMutation({
    mutationFn: (vars: { memberId: string; stationId: string; active: boolean }) =>
      setStationScopeFn({
        data: {
          tenantId: tenantId!,
          memberId: vars.memberId,
          stationId: vars.stationId,
          active: vars.active,
        },
      }),
    successMessage: "Station scope updated.",
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: ["restaurant.member-stations", tenantId, stationMemberId],
      }),
  });

  const removeFn = useServerFn(removeRestaurantMemberFn);
  const removeMember = useAdminMutation({
    mutationFn: (memberId: string) => removeFn({ data: { tenantId: tenantId!, memberId } }),
    successMessage: "Removed.",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.members", tenantId] }),
  });

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant yet"
        description="You're not a member of a LexiBite business yet."
      />
    );
  }

  const rows = (members.data ?? []) as {
    id: string;
    user_id: string;
    role: string;
    property_id: string | null;
    created_at: string;
  }[];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staff & roles"
        description="Who has access, and what they can do. Add staff before you need shift coverage."
      />
      <SectionCard title="Team" description="Everyone with access to this business.">
        {members.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No team members found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Team members and their roles</caption>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2 pr-4">
                    Person
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Role
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Scope
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    Production
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <Fragment key={m.id}>
                    <tr className="border-b last:border-0">
                      <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                        {m.user_id}
                      </td>
                      <td className="py-3 pr-4">
                        <label className="sr-only" htmlFor={`role-${m.id}`}>
                          Role for {m.user_id}
                        </label>
                        <select
                          id={`role-${m.id}`}
                          defaultValue={m.role}
                          disabled={updateRole.isPending}
                          onChange={(e) =>
                            updateRole.mutate({
                              memberId: m.id,
                              userId: m.user_id,
                              role: e.target.value,
                              propertyId: m.property_id,
                            })
                          }
                          className="min-h-11 rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                        >
                          {ASSIGNABLE_RESTAURANT_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {RESTAURANT_ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {m.property_id ? "One property" : "All properties"}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {["chef", "kitchen_manager", "bartender"].includes(m.role) && (
                          <Button
                            size="sm"
                            variant={stationMemberId === m.id ? "secondary" : "ghost"}
                            className="min-h-11 gap-2"
                            onClick={() =>
                              setStationMemberId((current) => (current === m.id ? null : m.id))
                            }
                          >
                            <MapPin className="size-4" />
                            Stations
                          </Button>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {confirmRemove === m.id ? (
                          <span className="inline-flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={removeMember.isPending}
                              onClick={() => {
                                removeMember.mutate(m.id);
                                setConfirmRemove(null);
                              }}
                            >
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${m.user_id}`}
                            onClick={() => setConfirmRemove(m.id)}
                            className="min-h-11 min-w-11"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                    {stationMemberId === m.id && (
                      <tr className="border-b bg-muted/20">
                        <td colSpan={5} className="px-2 py-3">
                          <div className="rounded-lg border bg-background p-3">
                            <div className="mb-2">
                              <p className="text-sm font-medium">Production stations</p>
                              <p className="text-xs text-muted-foreground">
                                Active assignments restrict this staff member&apos;s operational
                                board. Leave all stations unassigned to retain normal property
                                scope.
                              </p>
                            </div>
                            {stationScope.isLoading ? (
                              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" /> Loading stations…
                              </div>
                            ) : (stationScope.data?.stations ?? []).length === 0 ? (
                              <p className="py-3 text-sm text-muted-foreground">
                                No active production stations are configured for this property.
                              </p>
                            ) : (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {(stationScope.data?.stations ?? []).map(
                                  (station: {
                                    id: string;
                                    name: string;
                                    code: string;
                                    station_type: string;
                                    production_area?: string | null;
                                    parent_station_id?: string | null;
                                  }) => {
                                    const assigned = (stationScope.data?.assignments ?? []).some(
                                      (a: { station_id: string }) => a.station_id === station.id,
                                    );
                                    return (
                                      <label
                                        key={station.id}
                                        className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={assigned}
                                          disabled={setStation.isPending}
                                          onChange={(e) =>
                                            setStation.mutate({
                                              memberId: m.id,
                                              stationId: station.id,
                                              active: e.target.checked,
                                            })
                                          }
                                        />
                                        <span className="min-w-0">
                                          <span className="block truncate font-medium">
                                            {station.name}
                                          </span>
                                          <span className="block text-xs text-muted-foreground">
                                            {station.production_area ?? station.station_type}
                                            {station.code ? ` · ${station.code}` : ""}
                                          </span>
                                        </span>
                                      </label>
                                    );
                                  },
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Adding a new teammate" description="">
        <p className="text-sm text-muted-foreground">
          Inviting a new teammate by email isn&apos;t available yet — this panel manages access for
          people already on your team.
        </p>
      </SectionCard>
    </div>
  );
}
