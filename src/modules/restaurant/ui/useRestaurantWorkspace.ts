import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

const ACTIVE_PROPERTY_STORAGE_KEY = "lexibite.active-property";

type PropertyListener = () => void;

// All hook instances must share one selection. The shell and individual pages
// each call this hook; independent useState instances let one stale instance
// restore the previous property after navigation or refresh.
let sharedActivePropertyId: string | null = null;
let storeInitialized = false;
const listeners = new Set<PropertyListener>();

function readStoredPropertyId(): string | null {
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
    // The shared in-memory selection remains usable if storage is unavailable.
  }
}

function initializeStore() {
  if (storeInitialized || typeof window === "undefined") return;
  storeInitialized = true;
  sharedActivePropertyId = readStoredPropertyId();
}

function publishPropertyId(propertyId: string | null, persist = true) {
  initializeStore();
  if (sharedActivePropertyId === propertyId) {
    // Re-write the chosen value in case a browser extension or another tab
    // removed the key, without triggering needless React renders.
    if (persist) persistPropertyId(propertyId);
    return;
  }
  sharedActivePropertyId = propertyId;
  if (persist) persistPropertyId(propertyId);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: PropertyListener) {
  initializeStore();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  initializeStore();

  const [activePropertyId, setActivePropertyId] = useState<string | null>(
    sharedActivePropertyId,
  );

  useEffect(() => subscribe(() => setActivePropertyId(sharedActivePropertyId)), []);

  // Keep selections in sync across browser tabs. The value is still validated
  // against the properties returned for this authenticated workspace below.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_PROPERTY_STORAGE_KEY) {
        publishPropertyId(event.newValue, false);
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

  useEffect(() => {
    if (!query.data || properties.length === 0) return;

    // Retain the user's last property whenever it remains in this workspace.
    // Only fall back when the stored property is not accessible here.
    const selected =
      sharedActivePropertyId && properties.some((property) => property.id === sharedActivePropertyId)
        ? sharedActivePropertyId
        : properties[0].id;

    if (selected !== sharedActivePropertyId) publishPropertyId(selected);
    else if (readStoredPropertyId() !== selected) persistPropertyId(selected);
  }, [query.data, properties]);

  const selectProperty = useCallback((propertyId: string) => {
    if (!properties.some((property) => property.id === propertyId)) return;
    publishPropertyId(propertyId);
  }, [properties]);

  const activeProperty =
    properties.find((property) => property.id === activePropertyId) ?? properties[0] ?? null;

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
