import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

const ACTIVE_PROPERTY_STORAGE_KEY = "lexibite.active-property";

type PropertyListener = () => void;

const sharedPropertyIds = new Map<string, string | null>();
const propertyListeners = new Map<string, Set<PropertyListener>>();

function storageKey(tenantId: string) {
  return ACTIVE_PROPERTY_STORAGE_KEY + ":" + tenantId;
}

function readStoredPropertyId(tenantId: string) {
  if (typeof window === "undefined") return null;
  try {
    return (
      window.localStorage.getItem(storageKey(tenantId)) ??
      window.localStorage.getItem(ACTIVE_PROPERTY_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

function persistPropertyId(tenantId: string, propertyId: string | null) {
  if (typeof window === "undefined") return;
  try {
    const key = storageKey(tenantId);
    if (propertyId) {
      window.localStorage.setItem(key, propertyId);
      window.localStorage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, propertyId);
    } else {
      window.localStorage.removeItem(key);
      window.localStorage.removeItem(ACTIVE_PROPERTY_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable; shared in-memory state still works.
  }
}

function getSharedPropertyId(tenantId: string) {
  if (!sharedPropertyIds.has(tenantId)) {
    sharedPropertyIds.set(tenantId, readStoredPropertyId(tenantId));
  }
  return sharedPropertyIds.get(tenantId) ?? null;
}

function setSharedPropertyId(tenantId: string, propertyId: string | null) {
  const current = getSharedPropertyId(tenantId);
  if (current === propertyId) return;

  sharedPropertyIds.set(tenantId, propertyId);
  persistPropertyId(tenantId, propertyId);
  propertyListeners.get(tenantId)?.forEach((listener) => listener());
}

function subscribeToPropertySelection(tenantId: string, listener: PropertyListener) {
  getSharedPropertyId(tenantId);
  let listeners = propertyListeners.get(tenantId);
  if (!listeners) {
    listeners = new Set();
    propertyListeners.set(tenantId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (!listeners?.size) propertyListeners.delete(tenantId);
  };
}

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);

  const query = useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default"],
    queryFn: () => fn({ data: tenantId ? { tenantId } : {} }),
    staleTime: 60_000,
  });

  const properties = query.data?.properties ?? [];
  const resolvedTenantId = query.data?.tenant?.id ?? tenantId ?? "default";

  const [activePropertyId, setActivePropertyId] = useState<string | null>(() =>
    getSharedPropertyId(resolvedTenantId),
  );

  useEffect(() => {
    setActivePropertyId(getSharedPropertyId(resolvedTenantId));

    return subscribeToPropertySelection(resolvedTenantId, () => {
      setActivePropertyId(getSharedPropertyId(resolvedTenantId));
    });
  }, [resolvedTenantId]);

  useEffect(() => {
    if (!query.data) return;

    if (!properties.length) {
      if (getSharedPropertyId(resolvedTenantId) !== null) {
        setSharedPropertyId(resolvedTenantId, null);
      }
      return;
    }

    const current = getSharedPropertyId(resolvedTenantId);
    const selected =
      current && properties.some((property) => property.id === current)
        ? current
        : properties[0].id;

    if (selected !== current) {
      setSharedPropertyId(resolvedTenantId, selected);
    }
  }, [query.data, properties, resolvedTenantId]);

  const selectProperty = (propertyId: string) => {
    if (!properties.some((property) => property.id === propertyId)) return;
    setSharedPropertyId(resolvedTenantId, propertyId);
  };

  const activeProperty =
    properties.find((property) => property.id === activePropertyId) ??
    properties[0] ??
    null;

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
