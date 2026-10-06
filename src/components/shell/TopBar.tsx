import {
  Command as CommandIcon,
  LogOut,
  Menu,
  Search,
  Sparkles,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { PRODUCT } from "@/config/product";
import { ThemeToggle } from "@/components/os/ThemeToggle";
import type { Workspace } from "./types";
import { useRestaurantOperatingContext } from "@/modules/restaurant/ui/useRestaurantWorkspace";

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
  const { propertyId, locationId, setOperatingContext } = useRestaurantOperatingContext();

  const activePropertyId = workspace?.activePropertyId ?? propertyId ?? null;
  const activeProperty = workspace?.properties?.find((p) => p.id === activePropertyId) ?? null;
  const activeLocations = workspace?.locations?.filter((l) => l.property_id === activePropertyId) ?? [];
  const activeLocationId = workspace?.activeLocationId ?? locationId ?? null;

  // Establish a deterministic initial context once the workspace is known.
  // This is URL state, not hidden persistence, and the server revalidates it.
  useEffect(() => {
    if (!workspace?.properties?.length || propertyId) return;
    const firstProperty = workspace.properties[0];
    const firstLocation = workspace.locations.find((l) => l.property_id === firstProperty.id);
    setOperatingContext({ propertyId: firstProperty.id, locationId: firstLocation?.id ?? null });
  }, [workspace?.properties, workspace?.locations, propertyId, setOperatingContext]);

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
          <>
            <span className="nova-chip ml-2 hidden items-center gap-1.5 md:inline-flex">
              {workspace.tenant.settings?.business?.logoUrl && (
                <img
                  src={workspace.tenant.settings.business.logoUrl}
                  alt=""
                  className="size-5 shrink-0 rounded-sm object-contain"
                />
              )}
              <span>
                {workspace.tenant.settings?.business?.tradingName || workspace.tenant.name}
                {activeProperty?.name && <span>· {activeProperty.name}</span>}
                {workspace.locations?.find((l) => l.id === activeLocationId)?.name && (
                  <span>· {workspace.locations.find((l) => l.id === activeLocationId)?.name}</span>
                )}
              </span>
            </span>

            {workspace.properties.length > 1 && (
              <div className="ml-2 hidden items-center gap-1.5 lg:flex">
                <select
                  aria-label="Active property"
                  className="nova-chip min-h-9 max-w-44 border bg-[color:var(--nova-surface-2)] px-2 text-xs"
                  value={activePropertyId ?? ""}
                  onChange={(e) => {
                    const nextPropertyId = e.target.value;
                    const nextLocation = workspace.locations.find((l) => l.property_id === nextPropertyId);
                    setOperatingContext({ propertyId: nextPropertyId, locationId: nextLocation?.id ?? null });
                  }}
                >
                  {workspace.properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {activeLocations.length > 1 && (
                  <select
                    aria-label="Active outlet"
                    className="nova-chip min-h-9 max-w-40 border bg-[color:var(--nova-surface-2)] px-2 text-xs"
                    value={activeLocationId ?? ""}
                    onChange={(e) =>
                      setOperatingContext({ propertyId: activePropertyId!, locationId: e.target.value })
                    }
                  >
                    {activeLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </>
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
