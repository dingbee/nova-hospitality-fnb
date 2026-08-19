/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ShieldQuestion } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { LoadingState } from "@/components/os/LoadingState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { deleteMenuItemFn, getMenuBoardFn, transitionMenuItemFn } from "../lifecycle.functions";
import { MENU_LIFECYCLE_LABEL, type MenuLifecycleAction } from "../lifecycle";

const TONE: Record<string, StatusTone> = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  discontinued: "danger",
  archived: "neutral",
};

const ACTION_LABEL: Record<MenuLifecycleAction, string> = {
  activate: "Activate",
  pause: "Pause",
  resume: "Resume",
  discontinue: "Discontinue",
  archive: "Archive",
  restore: "Restore",
};

export function MenuLifecycleBoard({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const boardFn = useServerFn(getMenuBoardFn);
  const transitionFn = useServerFn(transitionMenuItemFn);
  const removeFn = useServerFn(deleteMenuItemFn);
  const [showArchived, setShowArchived] = useState(false);

  const board = useQuery({
    queryKey: ["restaurant.menu-board", tenantId, showArchived],
    queryFn: () => boardFn({ data: { tenantId, includeArchived: showArchived, windowDays: 30 } }),
    enabled: Boolean(tenantId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.menu-board", tenantId] });
    void qc.invalidateQueries({ queryKey: ["restaurant.menu-items", tenantId] });
  };

  const transition = useAdminMutation({
    mutationFn: (v: { menuItemId: string; action: MenuLifecycleAction }) =>
      transitionFn({ data: { tenantId, menuItemId: v.menuItemId, action: v.action } }),
    successMessage: "Lifecycle updated",
    onSuccess: invalidate,
  });

  const remove = useAdminMutation({
    mutationFn: (menuItemId: string) => removeFn({ data: { tenantId, menuItemId, confirm: true } }),
    successMessage: "Delete request processed",
    onSuccess: invalidate,
  });

  const rows = ((board.data as any)?.rows ?? []) as any[];
  const totals = (board.data as any)?.totals;

  return (
    <SectionCard
      title="Lifecycle & availability"
      description="An item exists, is sellable, or is retired — availability is derived from lifecycle, recipe state and stock on every read."
      actions={
        <Button size="sm" variant="outline" className="h-9" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
      }
    >
      {board.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState title="No menu items" description="Create items to manage their lifecycle." />
      ) : (
        <div className="space-y-3">
          {totals && (
            <p className="text-xs text-muted-foreground">
              {totals.items} items · {totals.active} active · {totals.sellable} sellable now ·{" "}
              {totals.needsAllergenReview} need allergen review
            </p>
          )}
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{r.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.price == null ? "no price" : `${r.currency} ${Number(r.price).toLocaleString()}`}
                      {r.quantitySold > 0 ? ` · ${r.quantitySold} sold / 30d` : " · no sales"}
                      {r.marginPercent != null ? ` · ${r.marginPercent}% margin` : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={TONE[r.lifecycle] ?? "neutral"}>
                      {MENU_LIFECYCLE_LABEL[r.lifecycle as keyof typeof MENU_LIFECYCLE_LABEL] ?? r.lifecycle}
                    </StatusChip>
                    <StatusChip tone={r.sellable ? "success" : "warning"}>
                      {r.sellable ? "Sellable" : "Not sellable"}
                    </StatusChip>
                    {r.allergens.resolution === "verify" && (
                      <StatusChip tone="warning">
                        <ShieldQuestion className="mr-1 inline h-3 w-3" /> Allergens unverified
                      </StatusChip>
                    )}
                    {r.allergens.resolution === "contains" && r.allergens.allergens.length > 0 && (
                      <StatusChip tone="neutral">{r.allergens.allergens.join(", ")}</StatusChip>
                    )}
                  </div>
                </div>

                {r.availabilityReasons.length > 0 && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{r.availabilityReasons.join(" · ")}</span>
                  </p>
                )}

                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {(r.actions as MenuLifecycleAction[]).map((a) => (
                      <Button
                        key={a}
                        size="sm"
                        variant="outline"
                        className="h-9"
                        disabled={transition.isPending}
                        onClick={() => transition.mutate({ menuItemId: r.id, action: a })}
                      >
                        {ACTION_LABEL[a]}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 text-destructive"
                      disabled={!r.deletable || remove.isPending}
                      title={r.deleteBlockReason ?? "Permanently delete"}
                      onClick={() => remove.mutate(r.id)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}