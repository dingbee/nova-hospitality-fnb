import {
  Command as CommandIcon,
  LogOut,
  Menu,
  Search,
  Building2,
  Sparkles,
} from "lucide-react";
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
  showAskNova,
  onOpenAskNova,
}: {
  mobileOpen: boolean;
  onToggleMobile: () => void;
  workspace: Workspace | undefined;
  principalEmail: string | null | undefined;
  roleSummary: string;
  onOpenPalette: () => void;
  onSignOut: () => void;
  /** Restaurant-role UI affordance only (see permissions.ts) — the server independently re-enforces intelligence.read on every request regardless of whether this button is shown. */
  showAskNova: boolean;
  onOpenAskNova: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--nova-line)] bg-[color:var(--nova-surface)]/90 backdrop-blur-xl">
      <div className="flex h-16 min-w-0 items-center gap-2 overflow-hidden px-2 sm:gap-3 sm:px-5">
        <button
          type="button"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          onClick={onToggleMobile}
          className="nova-action inline-flex size-10 shrink-0 items-center justify-center bg-[color:var(--nova-surface-2)] lg:size-11 lg:hidden"
        >
          <Menu className="size-5" />
        </button>

        <Link
          to="/admin/restaurant"
          className="flex min-w-0 shrink-0 items-center"
          aria-label="LexiBite"
        >
          <img
            src="/brand/lexibite-wordmark.svg"
            alt="LexiBite"
            className="h-8 w-auto max-w-[8rem] object-contain sm:h-10 sm:max-w-[11rem]"
          />
        </Link>

        {workspace?.tenant && (
          <div className="ml-1 flex min-w-0 items-center gap-2 sm:ml-2">
            <span className="nova-chip hidden max-w-56 items-center gap-1.5 sm:inline-flex">
              {workspace.tenant.settings?.business?.logoUrl && (
                <img
                  src={workspace.tenant.settings.business.logoUrl}
                  alt=""
                  className="size-5 shrink-0 rounded-sm object-contain"
                />
              )}
              <span className="truncate">
                {workspace.tenant.settings?.business?.tradingName || workspace.tenant.name}
              </span>
            </span>
            {workspace.properties.length > 1 ? (
              <label className="nova-action inline-flex min-h-10 items-center gap-2 bg-[color:var(--nova-surface-2)] px-2.5 text-xs">
                <Building2 className="size-3.5 text-[color:var(--nova-accent)]" aria-hidden="true" />
                <span className="sr-only">Active property</span>
                <select
                  aria-label="Active property"
                  value={workspace.activePropertyId ?? ""}
                  onChange={(event) => workspace.selectProperty(event.target.value)}
                  className="min-w-36 border-0 bg-transparent px-0 py-1 text-xs font-medium outline-none"
                >
                  {workspace.properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : workspace.activeProperty ? (
              <span className="nova-chip inline-flex items-center gap-1.5">
                <Building2 className="size-3.5 text-[color:var(--nova-accent)]" aria-hidden="true" />
                {workspace.activeProperty.name}
              </span>
            ) : null}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {showAskNova && (
            <button
              type="button"
              onClick={onOpenAskNova}
              aria-label={`Ask ${PRODUCT.aiName}`}
              className="nova-action inline-flex size-10 items-center justify-center bg-[color:var(--nova-accent)]/10 text-xs font-medium text-[color:var(--nova-accent)] sm:min-h-10 sm:w-auto sm:gap-2 sm:px-3"
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">Ask {PRODUCT.aiName}</span>
            </button>
          )}

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
            className="nova-action inline-flex size-10 items-center justify-center bg-[color:var(--nova-surface-2)] text-sm text-[color:var(--nova-ink-2)] sm:min-h-10 sm:h-auto sm:w-auto sm:gap-1.5 sm:px-3"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
      {/* Mobile workspace context: intentionally separate from the primary header so the
          tenant/property controls never compete with navigation, theme or account actions. */}
      {workspace?.tenant && (
        <div className="border-t border-[color:var(--nova-line)] px-3 py-2 lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <span className="nova-chip min-w-0 max-w-[52%] flex-1 items-center gap-1.5 truncate">
              {workspace.tenant.settings?.business?.logoUrl && (
                <img
                  src={workspace.tenant.settings.business.logoUrl}
                  alt=""
                  className="size-4 shrink-0 rounded-sm object-contain"
                />
              )}
              <span className="truncate">
                {workspace.tenant.settings?.business?.tradingName || workspace.tenant.name}
              </span>
            </span>

            {workspace.properties.length > 1 ? (
              <label className="nova-action inline-flex min-w-0 flex-1 items-center gap-1.5 bg-[color:var(--nova-surface-2)] px-2.5 text-xs">
                <Building2
                  className="size-3.5 shrink-0 text-[color:var(--nova-accent)]"
                  aria-hidden="true"
                />
                <span className="sr-only">Active property</span>
                <select
                  aria-label="Active property"
                  value={workspace.activePropertyId ?? ""}
                  onChange={(event) => workspace.selectProperty(event.target.value)}
                  className="min-w-0 flex-1 border-0 bg-transparent px-0 py-1 text-xs font-medium outline-none"
                >
                  {workspace.properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : workspace.activeProperty ? (
              <span className="nova-chip inline-flex min-w-0 flex-1 items-center gap-1.5 truncate">
                <Building2
                  className="size-3.5 shrink-0 text-[color:var(--nova-accent)]"
                  aria-hidden="true"
                />
                <span className="truncate">{workspace.activeProperty.name}</span>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </header>
  );
}
