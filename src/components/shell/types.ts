/**
 * Shared prop types for the shell's subcomponents, derived directly from
 * the hooks that produce them — kept in one place so TopBar/NavPanel never
 * drift from what NovaShell actually fetches.
 */
import type { usePrincipal } from "@/lib/rbac/usePermissions";
import type { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export type Principal = NonNullable<ReturnType<typeof usePrincipal>["data"]>;
export type Workspace = NonNullable<ReturnType<typeof useRestaurantWorkspace>["data"]>;
