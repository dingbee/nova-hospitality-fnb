import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

/**
 * Canonical restaurant operating context.
 *
 * Access is still enforced server-side by restaurant membership/RLS. These
 * values only select the property/outlet the operator is currently working
 * in. URL state is intentional: it survives refresh, is shareable/bookmarkable,
 * and is never persisted in localStorage.
 */
export function useRestaurantOperatingContext() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();
  const propertyId = search.property;
  const locationId = search.outlet;

  const setOperatingContext = (next: { propertyId: string; locationId?: string | null }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        property: next.propertyId,
        outlet: next.locationId ?? undefined,
      }),
    });
  };

  return { propertyId, locationId, setOperatingContext };
}

/** Resolves the restaurant tenant and the canonical active property/outlet. */
export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  const { propertyId, locationId } = useRestaurantOperatingContext();

  return useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default", propertyId ?? null, locationId ?? null],
    queryFn: () =>
      fn({
        data: {
          ...(tenantId ? { tenantId } : {}),
          ...(propertyId ? { propertyId } : {}),
          ...(locationId ? { locationId } : {}),
        },
      }),
  });
}
