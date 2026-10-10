import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";
import { createActivePropertyStore } from "./active-property-store";

const browserStorage = {
  getItem(key: string) {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  },
  removeItem(key: string) {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
};

// One module-level store is shared by the shell and page-level hook instances.
// The adapter resolves localStorage lazily, keeping SSR safe.
const activePropertyStore = createActivePropertyStore(browserStorage);

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  const [activePropertyId, setActivePropertyId] = useState<string | null>(
    () => activePropertyStore.get(),
  );

  useEffect(
    () => activePropertyStore.subscribe(() => setActivePropertyId(activePropertyStore.get())),
    [],
  );

  // Keep selections in sync across browser tabs. Storage is only a preference;
  // the server-provided workspace remains the source of authorization.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "lexibite.active-property") {
        activePropertyStore.set(event.newValue, false);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const query = useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default"],
    queryFn: () => fn({ data: tenantId ? { tenantId } : {} }),
    staleTime: 60_000,
  });

  const properties = query.data?.properties ?? [];
  const propertyIds = properties.map((property) => property.id);

  useEffect(() => {
    // An empty list here means the workspace is still loading or has no
    // properties. Never erase a stored choice while data is temporarily absent.
    if (!query.data || propertyIds.length === 0) return;
    activePropertyStore.resolve(propertyIds);
  }, [query.data, propertyIds.join("\u0000")]);

  const selectProperty = useCallback((propertyId: string) => {
    if (!propertyIds.includes(propertyId)) return;
    activePropertyStore.set(propertyId);
  }, [propertyIds.join("\u0000")]);

  const selectedId = propertyIds.includes(activePropertyId ?? "")
    ? activePropertyId
    : propertyIds.includes(activePropertyStore.get() ?? "")
      ? activePropertyStore.get()
      : propertyIds[0] ?? null;
  const activeProperty =
    properties.find((property) => property.id === selectedId) ?? null;

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
