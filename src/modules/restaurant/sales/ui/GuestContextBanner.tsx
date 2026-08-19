/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ShieldQuestion, UserRound } from "lucide-react";
import { StatusChip } from "@/components/os/StatusChip";
import { screenMenuForGuestFn } from "@/modules/restaurant/guest/guest-context.functions";

/**
 * Guest-aware service warning at the till.
 * It never says an item is safe — only that no conflict is on record.
 */
export function GuestContextBanner({ tenantId, orderId }: { tenantId: string; orderId: string }) {
  const screenFn = useServerFn(screenMenuForGuestFn);
  const q = useQuery({
    queryKey: ["restaurant.pos.guest-context", tenantId, orderId],
    queryFn: () => screenFn({ data: { tenantId, orderId } }),
    enabled: Boolean(tenantId && orderId),
  });

  const data = q.data as any;
  if (!data?.context?.guestId) return null;

  const { context, flags } = data;
  const conflicts = (flags as any[]).filter((f) => f.status === "conflict");
  const verify = (flags as any[]).filter((f) => f.status === "verify");

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <UserRound className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{context.guestName ?? "Known guest"}</span>
        {context.unknown ? (
          <StatusChip tone="neutral">No dietary context on record</StatusChip>
        ) : (
          <>
            {context.allergies.map((a: string) => (
              <StatusChip key={a} tone="danger">
                Allergy: {a}
              </StatusChip>
            ))}
            {context.diets.map((d: string) => (
              <StatusChip key={d} tone="warning">
                {d}
              </StatusChip>
            ))}
          </>
        )}
      </div>

      {conflicts.length > 0 && (
        <p className="mt-2 flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Do not serve without checking: {conflicts.slice(0, 5).map((f) => f.name).join(", ")}
            {conflicts.length > 5 ? ` +${conflicts.length - 5} more` : ""}
          </span>
        </p>
      )}
      {verify.length > 0 && (
        <p className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldQuestion className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Verify with the kitchen: {verify.slice(0, 5).map((f) => f.name).join(", ")}
            {verify.length > 5 ? ` +${verify.length - 5} more` : ""}
          </span>
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Allergen data is advisory. Confirm ingredients, modifiers and cross-contact with the kitchen before serving.
      </p>
    </div>
  );
}