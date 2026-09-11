/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary, matching PosWorkspace. */
import { Plus, UtensilsCrossed } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { money } from "./pos-types";

/**
 * A single catalogue tile: image, name, a one-line description when the
 * item has one, then price and any configuration badge. The whole tile is
 * the tap target — opening PosItemDialog is a single tap, not a tap-to-view
 * then tap-to-add. The trailing "+" is a visual affordance only (no
 * separate handler): it reinforces that tapping anywhere on the tile adds
 * the item, the same single action the button element already performs.
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
  const priceConfigured = item.priceConfigured !== false;
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
        <div className="mt-auto flex items-end justify-between gap-1.5 pt-1">
          {priceConfigured ? (
            <span className="text-sm font-semibold text-foreground tabular-nums">
              {money(Number(item.price ?? 0), currency)}
            </span>
          ) : (
            <Badge variant="secondary" className="w-fit">
              No active price
            </Badge>
          )}
          {priceConfigured && !disabled && (
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <Plus className="size-3.5" />
            </span>
          )}
        </div>
        {priceConfigured && (item.variants ?? []).length > 0 && (
          <Badge variant="secondary" className="w-fit">
            {item.variants.length} variants
          </Badge>
        )}
      </div>
    </button>
  );
}
