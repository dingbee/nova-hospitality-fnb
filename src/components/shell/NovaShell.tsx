import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePrincipal } from "@/lib/rbac/usePermissions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () => visibleGroups(principal?.permissions ?? []),
    [principal?.permissions],
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
      />

      <div className="flex">
        <aside
          aria-label="Primary navigation"
          className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 overflow-y-auto border-r border-[color:var(--nova-line)] bg-[color:var(--nova-surface)] lg:block"
        >
          <NavPanel groups={groups} collapsed={collapsed} onToggleGroup={toggleGroup} />
        </aside>

        <MobileNavDrawer
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          groups={groups}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
        />

        <main id="nova-main" className="min-w-0 flex-1 p-4 sm:p-6">
          {current && <Breadcrumb currentGroup={currentGroup} currentLabel={current.label} />}
          <div className="mx-auto max-w-[1600px] space-y-6">{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={groups} />
    </div>
  );
}
