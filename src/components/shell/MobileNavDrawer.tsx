import { X } from "lucide-react";
import { PRODUCT } from "@/config/product";
import type { NavGroup } from "./navigation";
import { NavPanel } from "./NavPanel";

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
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="absolute inset-y-0 left-0 w-[19rem] overflow-y-auto border-r border-[color:var(--nova-line)] bg-[color:var(--nova-surface)] shadow-2xl">
        <div className="flex h-16 items-center justify-between border-b border-[color:var(--nova-line)] px-4">
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
        <NavPanel groups={groups} collapsed={collapsed} onToggleGroup={onToggleGroup} />
      </div>
    </div>
  );
}
