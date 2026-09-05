/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary, matching PosWorkspace. */
import { UtensilsCrossed } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { money } from "./pos-types";

/**
 * A single catalogue tile: image, name, a one-line description when the
 * item has one, then price and any configuration badge. The whole tile is
 * the tap target — opening PosItemDialog is a single tap, not a tap-to-view
 * then tap-to-add.
 */
export function PosMenuItemCard({
  item,
  currency,
  disabled,
  onSelect,
}: {
  item: any;
  currency: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-colors hover:border-primary disabled:opacity-50"
    >
      <div className="flex aspect-square w-full items-center justify-center bg-muted">
        {item.image_url ? (
          <img src={item.image_url} alt="" className="size-full object-cover" />
        ) : (
          <UtensilsCrossed className="size-6 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2.5">
        <span className="text-sm font-medium leading-tight">{item.name}</span>
        {item.description && (
          <span className="line-clamp-1 text-[11px] text-muted-foreground">{item.description}</span>
        )}
        {item.priceConfigured === false ? null : (
          <span className="mt-auto pt-1 text-sm font-semibold text-foreground tabular-nums">
            {money(Number(item.price ?? 0), currency)}
          </span>
        )}
        {item.priceConfigured === false ? (
          <Badge variant="secondary" className="mt-auto w-fit">
            No active price
          </Badge>
        ) : (
          (item.variants ?? []).length > 0 && (
            <Badge variant="secondary" className="w-fit">
              {item.variants.length} variants
            </Badge>
          )
        )}
      </div>
    </button>
  );
}
