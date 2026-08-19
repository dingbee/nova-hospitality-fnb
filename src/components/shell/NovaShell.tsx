import type { ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { LogOut, UtensilsCrossed } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PRODUCT } from "@/config/product";
import { usePrincipal } from "@/lib/rbac/usePermissions";

/**
 * The F&B staff portal chrome. It is deliberately self-contained: there is no
 * parent hospitality suite to return to, and no public marketing site.
 */
export function NovaShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: principal } = usePrincipal();

  const signOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
          <Link to="/admin/restaurant" className="flex items-center gap-2 font-medium">
            <UtensilsCrossed className="size-5 text-primary" />
            <span className="hidden sm:inline">{PRODUCT.shortName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-sm text-muted-foreground">{PRODUCT.tagline}</span>
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {principal?.email && (
              <span className="hidden text-muted-foreground md:inline">
                {principal.email}
                {principal.roles.length > 0 && ` · ${principal.roles.join(", ")}`}
              </span>
            )}
            <button
              type="button"
              onClick={signOut}
              className="inline-flex min-h-9 items-center gap-1.5 rounded px-3 text-muted-foreground hover:bg-muted"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] p-4">{children}</main>
    </div>
  );
}
