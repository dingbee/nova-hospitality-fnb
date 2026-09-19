/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue rows are untyped at this boundary, matching PosMenuItemCard. */
import { Plus, UtensilsCrossed } from "lucide-react";
import { money } from "../pos-types";

/**
 * The mobile catalogue tile — image-dominant, two-column grid. Same data
 * shape as PosMenuItemCard (the desktop card); a separate component because
 * the mobile design calls for a visually dominant image and a bigger tap
 * target, not because the underlying item differs.
 */
export function MobileMenuItemCard({
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
      className="flex flex-col overflow-hidden rounded-2xl border bg-card text-left shadow-sm active:scale-[0.98] disabled:opacity-50"
    >
      <div className="flex aspect-[4/3] w-full items-center justify-center bg-muted">
        {item.image_url ? (
          <img src={item.image_url} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="text-sm font-semibold leading-tight">{item.name}</span>
        {(item.variants ?? []).length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {item.variants.length} option{item.variants.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="mt-auto flex items-end justify-between gap-1.5 pt-1">
          {priceConfigured ? (
            <span className="text-[15px] font-bold tabular-nums" style={{ color: "var(--lb-green)" }}>
              {money(Number(item.price ?? 0), currency)}
            </span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">No active price</span>
          )}
          {priceConfigured && !disabled && (
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-white"
              style={{ background: "var(--lb-green)" }}
            >
              <Plus className="size-4" strokeWidth={2.5} />
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
