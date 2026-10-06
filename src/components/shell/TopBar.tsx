import {
  Command as CommandIcon,
  LogOut,
  Menu,
  Search,
  Sparkles,
} from "lucide-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
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
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { propertyId?: string; outletId?: string };
  const activeProperty = workspace?.properties.find((p) => p.id === workspace.activePropertyId) ?? null;
  const activeOutlet = workspace?.locations.find((l) => l.id === workspace.activeLocationId) ?? null;
  const outletsForProperty = workspace?.activePropertyId
    ? workspace.locations.filter((l) => l.property_id === workspace.activePropertyId)
    : [];

  const switchProperty = (propertyId: string) => {
    void navigate({
      search: (prev) => ({ ...prev, propertyId, outletId: undefined }),
    });
  };

  const switchOutlet = (outletId: string) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        propertyId: workspace?.activePropertyId ?? search.propertyId,
        outletId,
      }),
    });
  };

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

        <Link to="/admin/restaurant" className="flex shrink-0 items-center" aria-label="LexiBite">
          <img
            src="/brand/lexibite-wordmark.svg"
            alt="LexiBite"
            className="h-10 w-auto max-w-[11rem] object-contain"
          />
        </Link>

        {workspace?.tenant && (
          <span className="nova-chip ml-2 hidden items-center gap-1.5 md:inline-flex">
            {workspace.tenant.settings?.business?.logoUrl && (
              <img
                src={workspace.tenant.settings.business.logoUrl}
                alt=""
                className="size-5 shrink-0 rounded-sm object-contain"
              />
            )}
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">
                {workspace.tenant.settings?.business?.tradingName || workspace.tenant.name}
              </span>
              {workspace.properties.length > 0 && (
                <select
                  aria-label="Active property"
                  value={workspace.activePropertyId ?? ""}
                  onChange={(e) => switchProperty(e.target.value)}
                  className="max-w-[12rem] rounded-md border bg-background px-2 py-1 text-xs font-medium"
                >
                  {workspace.properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              )}
              {outletsForProperty.length > 0 && (
                <select
                  aria-label="Active outlet"
                  value={workspace.activeLocationId ?? ""}
                  onChange={(e) => switchOutlet(e.target.value)}
                  className="max-w-[11rem] rounded-md border bg-background px-2 py-1 text-xs"
                >
                  {outletsForProperty.map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </option>
                  ))}
                </select>
              )}
              {activeProperty && outletsForProperty.length === 0 && (
                <span className="hidden text-xs text-muted-foreground sm:inline">No active outlet</span>
              )}
            </span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {showAskNova && (
            <button
              type="button"
              onClick={onOpenAskNova}
              className="nova-action inline-flex min-h-10 items-center gap-2 bg-[color:var(--nova-accent)]/10 px-3 text-xs font-medium text-[color:var(--nova-accent)]"
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
