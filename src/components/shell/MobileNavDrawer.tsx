import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { PRODUCT } from "@/config/product";
import type { NavGroup } from "./navigation";
import { NavPanel } from "./NavPanel";

const MOBILE_NAV_SCROLL_KEY = "nova-navigation-scroll-mobile";

/** The below-lg equivalent of the desktop nav rail — an overlay + slide-in panel, closed by default. */
export function MobileNavDrawer({
  open,
  onClose,
  groups,
  collapsed,
  onToggleGroup,
}: {
  open: boolean;
  onClose: () => void;
  groups: NavGroup[];
  collapsed: Record<string, boolean>;
  onToggleGroup: (label: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const element = scrollRef.current;
    if (!element) return;
    try {
      const saved = Number(window.localStorage.getItem(MOBILE_NAV_SCROLL_KEY) ?? 0);
      if (Number.isFinite(saved) && saved > 0) element.scrollTop = saved;
    } catch {
      // Navigation remains usable when browser storage is unavailable.
    }
  }, [open]);

  const saveScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    try {
      window.localStorage.setItem(MOBILE_NAV_SCROLL_KEY, String(element.scrollTop));
    } catch {
      // Ignore storage restrictions; scrolling remains unaffected.
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="absolute inset-y-0 left-0 flex w-[19rem] flex-col overflow-hidden border-r border-[color:var(--nova-line)] bg-[color:var(--nova-surface)] shadow-2xl">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-[color:var(--nova-line)] px-4">
          <span className="text-sm font-semibold">{PRODUCT.shortName}</span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="nova-action inline-flex size-10 items-center justify-center"
          >
            <X className="size-4" />
          </button>
        </div>
        <div
          ref={scrollRef}
          onScroll={saveScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <NavPanel groups={groups} collapsed={collapsed} onToggleGroup={onToggleGroup} />
        </div>
      </div>
    </div>
  );
}
