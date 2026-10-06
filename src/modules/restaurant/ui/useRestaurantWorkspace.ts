import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSearch } from "@tanstack/react-router";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

/**
 * Canonical restaurant workspace query.
 *
 * Property/outlet context is URL-backed, not localStorage-backed: it is
 * shareable, refresh-safe, and inherited across the authenticated route tree.
 * The server validates the requested ids against the caller's actual grants.
 */
export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  const search = useSearch({ strict: false }) as {
    propertyId?: string;
    outletId?: string;
  };

  const propertyId = search.propertyId;
  const locationId = search.outletId;

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
