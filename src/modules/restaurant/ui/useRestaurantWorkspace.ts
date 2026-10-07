import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

const ACTIVE_PROPERTY_STORAGE_KEY = "lexibite.active-property";

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  const [activePropertyId, setActivePropertyId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(ACTIVE_PROPERTY_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const query = useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default"],
    queryFn: () => fn({ data: tenantId ? { tenantId } : {} }),
    staleTime: 60_000,
  });

  const properties = query.data?.properties ?? [];
  useEffect(() => {
    if (!query.data) return;
    if (!properties.length) {
      if (activePropertyId !== null) setActivePropertyId(null);
      return;
    }
    const selected = activePropertyId && properties.some((p) => p.id === activePropertyId)
      ? activePropertyId
      : properties[0].id;
    if (selected !== activePropertyId) {
      setActivePropertyId(selected);
      try {
        window.localStorage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, selected);
      } catch {
        // Storage can be unavailable in private browsing; in-memory state still works.
      }
    }
  }, [activePropertyId, properties]);

  const selectProperty = (propertyId: string) => {
    if (!properties.some((p) => p.id === propertyId)) return;
    setActivePropertyId(propertyId);
    try {
      window.localStorage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, propertyId);
    } catch {
      // In-memory selection remains active for this session.
    }
  };

  const activeProperty = properties.find((p) => p.id === activePropertyId) ?? properties[0] ?? null;

  return {
    ...query,
    data: query.data
      ? {
          ...query.data,
          activePropertyId: activeProperty?.id ?? null,
          activeProperty,
          selectProperty,
        }
      : query.data,
  };
}
