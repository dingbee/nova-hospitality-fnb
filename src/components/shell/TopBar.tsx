import { Command as CommandIcon, LogOut, Menu, Search, UtensilsCrossed } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { PRODUCT } from "@/config/product";
import { ThemeToggle } from "@/components/os/ThemeToggle";
import type { Workspace } from "./types";

/** The sticky header: mobile nav toggle, product mark, active workspace chip, command palette trigger, theme toggle, identity and sign-out. */
export function TopBar({
  mobileOpen,
  onToggleMobile,
  workspace,
  principalEmail,
  roleSummary,
  onOpenPalette,
  onSignOut,
}: {
  mobileOpen: boolean;
  onToggleMobile: () => void;
  workspace: Workspace | undefined;
  principalEmail: string | null | undefined;
  roleSummary: string;
  onOpenPalette: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--nova-line)] bg-[color:var(--nova-surface)]/90 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-3 sm:px-5">
        <button
          type="button"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          onClick={onToggleMobile}
          className="nova-action inline-flex size-11 items-center justify-center bg-[color:var(--nova-surface-2)] lg:hidden"
        >
          <Menu className="size-5" />
        </button>

        <Link to="/admin/restaurant" className="flex items-center gap-2.5">
          <span className="nova-logo flex size-9 items-center justify-center rounded-xl text-[color:var(--nova-accent)]">
            <UtensilsCrossed className="size-[18px]" />
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-sm font-semibold tracking-tight text-[color:var(--nova-ink)]">
              {PRODUCT.shortName}
            </span>
            <span className="block text-[0.68rem] text-[color:var(--nova-ink-3)]">
              {PRODUCT.tagline}
            </span>
          </span>
        </Link>

        {workspace?.tenant && (
          <span className="nova-chip ml-2 hidden md:inline-flex">
            {workspace.tenant.name}
            {workspace.properties?.[0]?.name && <span>· {workspace.properties[0].name}</span>}
            {workspace.locations?.[0]?.name && <span>· {workspace.locations[0].name}</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenPalette}
            className="nova-action hidden min-h-10 items-center gap-2 bg-[color:var(--nova-sunken)] px-3 text-xs text-[color:var(--nova-ink-3)] md:inline-flex"
          >
            <Search className="size-3.5" />
            Jump to…
            <kbd className="ml-1 rounded border px-1.5 py-0.5 text-[0.6rem]">
              <CommandIcon className="inline size-2.5" />K
            </kbd>
          </button>

          <ThemeToggle />

          {principalEmail && (
            <span className="hidden max-w-[16rem] text-right text-xs leading-tight md:block">
              <span className="block truncate text-[color:var(--nova-ink)]">{principalEmail}</span>
              {roleSummary && (
                <span className="block truncate text-[color:var(--nova-ink-3)]">{roleSummary}</span>
              )}
            </span>
          )}

          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            className="nova-action inline-flex min-h-10 items-center gap-1.5 bg-[color:var(--nova-surface-2)] px-3 text-sm text-[color:var(--nova-ink-2)]"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
