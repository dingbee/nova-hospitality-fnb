import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

const ACTIVE_PROPERTY_STORAGE_KEY = "lexibite.active-property";

type PropertyListener = () => void;

let sharedActivePropertyId: string | null = null;
let sharedStoreInitialized = false;
const propertyListeners = new Set<PropertyListener>();

function readStoredPropertyId() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_PROPERTY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistPropertyId(propertyId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (propertyId) {
      window.localStorage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, propertyId);
    } else {
      window.localStorage.removeItem(ACTIVE_PROPERTY_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable; the shared in-memory state still works.
  }
}

function initializeSharedPropertyStore() {
  if (sharedStoreInitialized || typeof window === "undefined") return;
  sharedStoreInitialized = true;
  sharedActivePropertyId = readStoredPropertyId();
}

function setSharedActivePropertyId(propertyId: string | null) {
  initializeSharedPropertyStore();
  if (sharedActivePropertyId === propertyId) return;

  sharedActivePropertyId = propertyId;
  persistPropertyId(propertyId);
  propertyListeners.forEach((listener) => listener());
}

function subscribeToPropertySelection(listener: PropertyListener) {
  initializeSharedPropertyStore();
  propertyListeners.add(listener);
  return () => propertyListeners.delete(listener);
}

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  initializeSharedPropertyStore();

  const [activePropertyId, setActivePropertyId] = useState<string | null>(
    sharedActivePropertyId,
  );

  useEffect(() => {
    return subscribeToPropertySelection(() => {
      setActivePropertyId(sharedActivePropertyId);
    });
  }, []);

  const query = useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default"],
    queryFn: () => fn({ data: tenantId ? { tenantId } : {} }),
    staleTime: 60_000,
  });

  const properties = query.data?.properties ?? [];
  useEffect(() => {
    if (!query.data) return;

    if (!properties.length) {
      if (sharedActivePropertyId !== null) {
        setSharedActivePropertyId(null);
      }
      return;
    }

    const selected =
      sharedActivePropertyId && properties.some((p) => p.id === sharedActivePropertyId)
        ? sharedActivePropertyId
        : properties[0].id;

    if (selected !== sharedActivePropertyId) {
      setSharedActivePropertyId(selected);
    }
  }, [query.data, properties]);

  const selectProperty = (propertyId: string) => {
    if (!properties.some((p) => p.id === propertyId)) return;
    setSharedActivePropertyId(propertyId);
  };

  const activeProperty =
    properties.find((p) => p.id === activePropertyId) ?? properties[0] ?? null;

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
