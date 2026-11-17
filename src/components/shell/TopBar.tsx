import {
  Command as CommandIcon,
  LogOut,
  Menu,
  X,
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
  const businessName = workspace?.tenant?.settings?.business?.tradingName || workspace?.tenant?.name;

  const propertySelector = (mobile: boolean) => {
    if (!workspace?.tenant) return null;
    if (workspace.properties.length <= 1) {
      return workspace.activeProperty ? (
        <span className={mobile
          ? "nova-chip inline-flex min-w-0 flex-1 items-center gap-1.5 truncate"
          : "nova-chip inline-flex items-center gap-1.5"
        }>
          <Building2 className="size-3.5 shrink-0 text-[color:var(--nova-accent)]" aria-hidden="true" />
          <span className={mobile ? "truncate" : undefined}>{workspace.activeProperty.name}</span>
        </span>
      ) : null;
    }

    return (
      <label className={mobile
        ? "nova-action inline-flex min-w-0 flex-1 items-center gap-1.5 bg-[color:var(--nova-surface-2)] px-2.5 text-xs"
        : "nova-action inline-flex min-h-10 items-center gap-2 bg-[color:var(--nova-surface-2)] px-2.5 text-xs"
      }>
        <Building2 className="size-3.5 shrink-0 text-[color:var(--nova-accent)]" aria-hidden="true" />
        <span className="sr-only">Active property</span>
        <select
          aria-label="Active property"
          value={workspace.activePropertyId ?? ""}
          onChange={(event) => workspace.selectProperty(event.target.value)}
          className={mobile
            ? "min-w-0 flex-1 border-0 bg-transparent px-0 py-1 text-xs font-medium outline-none"
            : "min-w-36 border-0 bg-transparent px-0 py-1 text-xs font-medium outline-none"
          }
        >
          {workspace.properties.map((property) => (
            <option key={property.id} value={property.id}>{property.name}</option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--nova-line)] bg-[color:var(--nova-surface)]/90 backdrop-blur-xl">
      <div className="flex h-16 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-5">
        <button
          type="button"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          onClick={onToggleMobile}
          className="nova-action inline-flex size-11 shrink-0 items-center justify-center bg-[color:var(--nova-surface-2)] lg:hidden"
        >
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>

        <Link to="/admin/restaurant" className="flex min-w-0 shrink items-center" aria-label="LexiBite">
          <img
            src="/brand/lexibite-wordmark.svg"
            alt="LexiBite"
            className="h-9 w-auto max-w-[8.5rem] object-contain sm:h-10 sm:max-w-[11rem]"
          />
        </Link>

        {workspace?.tenant && (
          <div className="ml-1 hidden min-w-0 items-center gap-2 sm:flex sm:ml-2">
            <span className="nova-chip inline-flex max-w-56 min-w-0 items-center gap-1.5">
              {workspace.tenant.settings?.business?.logoUrl && (
                <img src={workspace.tenant.settings.business.logoUrl} alt="" className="size-5 shrink-0 rounded-sm object-contain" />
              )}
              <span className="truncate">{businessName}</span>
            </span>
            {propertySelector(false)}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {showAskNova && (
            <button
              type="button"
              onClick={onOpenAskNova}
              aria-label={`Ask ${PRODUCT.aiName}`}
              className="nova-action inline-flex size-10 items-center justify-center bg-[color:var(--nova-accent)]/10 text-[color:var(--nova-accent)] sm:w-auto sm:gap-2 sm:px-3 sm:text-xs sm:font-medium"
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">Ask {PRODUCT.aiName}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Jump to"
            className="nova-action hidden min-h-10 items-center gap-2 bg-[color:var(--nova-sunken)] px-3 text-xs text-[color:var(--nova-ink-3)] md:inline-flex"
          >
            <Search className="size-3.5" />
            Jump to…
            <kbd className="ml-1 rounded border px-1.5 py-0.5 text-[0.6rem]"><CommandIcon className="inline size-2.5" />K</kbd>
          </button>

          <ThemeToggle />

          {principalEmail && (
            <span className="hidden max-w-[16rem] text-right text-xs leading-tight md:block">
              <span className="block truncate text-[color:var(--nova-ink)]">{principalEmail}</span>
              {roleSummary && <span className="block truncate text-[color:var(--nova-ink-3)]">{roleSummary}</span>}
            </span>
          )}

          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            className="nova-action inline-flex size-10 items-center justify-center bg-[color:var(--nova-surface-2)] text-sm text-[color:var(--nova-ink-2)] sm:w-auto sm:gap-1.5 sm:px-3"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>

      {/* A single mobile context row prevents workspace controls competing with the brand and account actions. */}
      {workspace?.tenant && (
        <div className="border-t border-[color:var(--nova-line)] px-3 py-2 lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <span className="nova-chip inline-flex min-w-0 max-w-[52%] flex-1 items-center gap-1.5 truncate">
              {workspace.tenant.settings?.business?.logoUrl && (
                <img src={workspace.tenant.settings.business.logoUrl} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
              )}
              <span className="truncate">{businessName}</span>
            </span>
            {propertySelector(true)}
          </div>
        </div>
      )}
    </header>
  );
}
