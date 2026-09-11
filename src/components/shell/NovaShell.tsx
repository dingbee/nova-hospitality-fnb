import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, LogOut, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePrincipal } from "@/lib/rbac/usePermissions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import { StaffNovaPanel } from "@/modules/restaurant/staffnova/ui/StaffNovaPanel";
import { activeItem, groupOf, visibleGroups } from "./navigation";
import { CommandPalette } from "./CommandPalette";
import { TopBar } from "./TopBar";
import { NavPanel } from "./NavPanel";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { Breadcrumb } from "./Breadcrumb";

export function NovaShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: principal, error: principalError } = usePrincipal();
  const { data: workspace } = useRestaurantWorkspace();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [staffNovaOpen, setStaffNovaOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Desktop sidebar rail collapse — a per-viewer display preference, not
  // data, so it lives in localStorage rather than round-tripping to the
  // server. Read lazily (not in an effect) so the very first paint already
  // reflects the viewer's last choice instead of flashing expanded first.
  const [railCollapsed, setRailCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("nova-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleRail = () => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("nova-sidebar-collapsed", next ? "1" : "0");
      } catch {
        // Private browsing / storage disabled — the toggle still works for
        // this session, it just won't be remembered next visit.
      }
      return next;
    });
  };

  // UI affordance only — askStaffNovaFn independently re-enforces
  // intelligence.read server-side against the verified JWT userId on every
  // request, so hiding/showing this button changes discoverability, never
  // authorization.
  const canAskStaffNova = hasRestaurantCapability(
    workspace?.roles ?? [],
    "intelligence.read",
    workspace?.platformAdmin ?? false,
  );

  const groups = useMemo(
    () => visibleGroups(principal?.permissions ?? [], principal?.commercialAdmin ?? false),
    [principal?.permissions, principal?.commercialAdmin],
  );
  const current = activeItem(pathname);
  const currentGroup = groupOf(current);
  const roleSummary = useMemo(() => {
    const unique = Array.from(new Set(principal?.roles ?? []));
    if (!unique.length) return "";
    const shown = unique.slice(0, 2).join(", ");
    return unique.length > 2 ? `${shown} +${unique.length - 2}` : shown;
  }, [principal?.roles]);

  useEffect(() => setMobileOpen(false), [pathname]);

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const toggleGroup = (label: string) =>
    setCollapsed((c) => ({ ...c, [label]: !(c[label] ?? false) }));

  const inactive =
    principalError instanceof Error && /disabled|enrolment/i.test(principalError.message ?? "");
  if (inactive) {
    return (
      <div className="nova-os flex min-h-screen items-center justify-center px-4">
        <div className="nova-surface max-w-md p-8 text-center">
          <ShieldAlert className="mx-auto size-8 text-[color:var(--nova-danger)]" />
          <h1 className="nova-title mt-4 text-xl">Access unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">{principalError.message}</p>
          <button
            type="button"
            onClick={signOut}
            className="nova-action mt-6 inline-flex min-h-11 items-center justify-center gap-2 bg-[color:var(--nova-accent)] px-5 text-sm font-medium text-white"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="nova-os min-h-screen">
      <a href="#nova-main" className="sr-only focus:not-sr-only">
        Skip to content
      </a>

      <TopBar
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((o) => !o)}
        workspace={workspace}
        principalEmail={principal?.email}
        roleSummary={roleSummary}
        onOpenPalette={() => setPaletteOpen(true)}
        onSignOut={signOut}
        showAskNova={canAskStaffNova}
        onOpenAskNova={() => setStaffNovaOpen(true)}
      />

      <div className="flex">
        <aside
          aria-label="Primary navigation"
          className={`sticky top-16 hidden h-[calc(100vh-4rem)] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--nova-line)] bg-[color:var(--nova-surface)] transition-[width] duration-150 lg:flex ${
            railCollapsed ? "w-16" : "w-64"
          }`}
        >
          <div className="flex-1 overflow-y-auto">
            <NavPanel
              groups={groups}
              collapsed={collapsed}
              onToggleGroup={toggleGroup}
              rail={railCollapsed}
            />
          </div>
          <button
            type="button"
            onClick={toggleRail}
            aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={railCollapsed ? "Expand navigation" : "Collapse navigation"}
            className="sticky bottom-0 flex min-h-11 shrink-0 items-center justify-center gap-2 border-t border-[color:var(--nova-line)] bg-[color:var(--nova-surface)] text-xs font-medium text-[color:var(--nova-ink-3)] hover:text-[color:var(--nova-ink)]"
          >
            {railCollapsed ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronLeft className="size-4" />
            )}
            {!railCollapsed && "Collapse"}
          </button>
        </aside>

        <MobileNavDrawer
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          groups={groups}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
        />

        <main
          id="nova-main"
          className="flex h-[calc(100vh-4rem)] min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6"
        >
          {current && (
            <div className="shrink-0">
              <Breadcrumb currentGroup={currentGroup} currentLabel={current.label} />
            </div>
          )}
          {/* min-h-0 lets a workspace page (e.g. POS, KDS) opt into filling exactly
              the remaining height with its own `h-full` root and manage its own
              internal scroll regions — main itself is the one scroll container for
              every other page, unchanged. */}
          <div className="mx-auto min-h-0 w-full max-w-[1600px] flex-1 space-y-6">{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={groups} />

      {canAskStaffNova && workspace?.tenant && (
        <StaffNovaPanel
          open={staffNovaOpen}
          onOpenChange={setStaffNovaOpen}
          tenantId={workspace.tenant.id}
        />
      )}
    </div>
  );
}
