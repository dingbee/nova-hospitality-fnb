import { ChefHat, LayoutGrid, MoreHorizontal, Plus, ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MobileScreen } from "./types";

const TABS: { screen: MobileScreen; label: string; icon: typeof LayoutGrid }[] = [
  { screen: "tables", label: "Tables", icon: LayoutGrid },
  { screen: "kitchen", label: "Orders", icon: ChefHat },
  { screen: "receipts", label: "Receipts", icon: ReceiptText },
  { screen: "more", label: "More", icon: MoreHorizontal },
];

/**
 * The persistent bottom nav — Tables / Orders / (+) / Receipts / More.
 * Fixed across the primary POS experience (never hidden by scrolling), and
 * safe-area aware for phones with a home indicator.
 */
export function MobilePosBottomNav({
  active,
  onSelect,
  onNewOrder,
}: {
  active: MobileScreen;
  onSelect: (screen: MobileScreen) => void;
  onNewOrder: () => void;
}) {
  const [left, right] = [TABS.slice(0, 2), TABS.slice(2)];
  return (
    <nav
      className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)]"
      style={{ borderColor: "color-mix(in oklab, var(--lb-green) 18%, transparent)" }}
      aria-label="Primary"
    >
      <div className="grid grid-cols-5 items-end px-1 pt-1.5">
        {left.map((tab) => (
          <NavButton key={tab.screen} tab={tab} active={active === tab.screen} onSelect={onSelect} />
        ))}

        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={onNewOrder}
            className="-mt-6 flex size-14 shrink-0 items-center justify-center rounded-full text-white shadow-lg active:scale-95"
            style={{ background: "var(--lb-green)" }}
            aria-label="New order"
          >
            <Plus className="size-7" strokeWidth={2.5} />
          </button>
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            New
          </span>
        </div>

        {right.map((tab) => (
          <NavButton key={tab.screen} tab={tab} active={active === tab.screen} onSelect={onSelect} />
        ))}
      </div>
    </nav>
  );
}

function NavButton({
  tab,
  active,
  onSelect,
}: {
  tab: (typeof TABS)[number];
  active: boolean;
  onSelect: (screen: MobileScreen) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.screen)}
      className={cn(
        "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
        active ? "text-[color:var(--lb-green)]" : "text-muted-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <tab.icon className="size-5" strokeWidth={active ? 2.4 : 2} />
      {tab.label}
    </button>
  );
}
