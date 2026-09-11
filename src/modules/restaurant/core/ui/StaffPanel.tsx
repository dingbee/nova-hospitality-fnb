/**
 * Staff & roles — list current team members, change their role or property
 * scope, remove access. Every write goes through the same capability-gated
 * `members.server.ts` functions the rest of the app uses — this panel adds
 * no new authorization logic.
 *
 * Adding a brand-new teammate isn't available from here yet: `upsertMember`
 * takes an existing auth user id, and there's no invite-by-email flow built
 * — that's a real, disclosed gap, not something this panel papers over.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import {
  listRestaurantMembersFn,
  removeRestaurantMemberFn,
  upsertRestaurantMemberFn,
} from "../tenancy.functions";
import { RESTAURANT_ROLES } from "../contracts";
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
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
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
                        {RESTAURANT_ROLES.map((r) => (
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
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
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
