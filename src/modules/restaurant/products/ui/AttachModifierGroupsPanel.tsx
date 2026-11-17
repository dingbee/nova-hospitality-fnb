/**
 * Attach/detach modifier groups on a product.
 */
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { attachRestaurantModifierGroupFn, listRestaurantModifierGroupsFn } from "../catalog.functions";

export function AttachModifierGroupsPanel({
  tenantId,
  productId,
  attachedGroupIds,
}: {
  tenantId: string;
  productId: string;
  attachedGroupIds: string[];
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listRestaurantModifierGroupsFn);
  const attachFn = useServerFn(attachRestaurantModifierGroupFn);

  const groups = useQuery({
    queryKey: ["restaurant.modifier-groups", tenantId],
    queryFn: () => listFn({ data: { tenantId } }),
  });

  const toggle = useAdminMutation({
    mutationFn: (vars: { groupId: string; attached: boolean }) =>
      attachFn({ data: { tenantId, productId, groupId: vars.groupId, attached: vars.attached } }),
    successMessage: "Modifier groups updated",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.product", tenantId, productId] });
    },
  });

  const rows = ((groups.data as any[]) ?? []).filter((g) => g.active !== false);

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No modifier groups yet.</p>
      ) : (
        rows.map((g) => {
          const attached = attachedGroupIds.includes(g.id);
          return (
            <div key={g.id} className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span>
                {g.name} <span className="text-xs text-muted-foreground">{g.code}</span>
              </span>
              <Switch checked={attached} onCheckedChange={(v) => toggle.mutate({ groupId: g.id, attached: v })} />
            </div>
          );
        })
      )}
    </div>
  );
}
