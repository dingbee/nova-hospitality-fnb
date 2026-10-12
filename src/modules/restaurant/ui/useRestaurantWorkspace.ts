import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRestaurantWorkspaceFn } from "../core/tenancy.functions";

/**
 * Property selection is UI context, never an authorization grant.
 *
 * Keep one external store per tenant so every hook consumer (shell, POS,
 * inventory, etc.) observes the same selection immediately. Persist per
 * tenant rather than in one global key, and validate every restored value
 * against the caller's server-authorized property list before using it.
 */
const ACTIVE_PROPERTY_STORAGE_PREFIX = "lexibite.active-property:";
type PropertyStore = { value: string | null; listeners: Set<() => void> };
const stores = new Map<string, PropertyStore>();

function storageKey(scope: string) {
  return `${ACTIVE_PROPERTY_STORAGE_PREFIX}${scope}`;
}

function getStore(scope: string): PropertyStore {
  const existing = stores.get(scope);
  if (existing) return existing;

  let value: string | null = null;
  if (typeof window !== "undefined") {
    try {
      value = window.localStorage.getItem(storageKey(scope));
    } catch {
      // Private browsing / disabled storage: retain an in-memory selection.
    }
  }

  const store = { value, listeners: new Set<() => void>() };
  stores.set(scope, store);
  return store;
}

function notify(store: PropertyStore) {
  store.listeners.forEach((listener) => listener());
}

function subscribe(scope: string, listener: () => void) {
  const store = getStore(scope);
  store.listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey(scope) && event.key !== null) return;
    let next: string | null = null;
    try {
      next = window.localStorage.getItem(storageKey(scope));
    } catch {
      return;
    }
    if (next !== store.value) {
      store.value = next;
      notify(store);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    store.listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(scope: string) {
  return getStore(scope).value;
}

function getServerSnapshot() {
  return null;
}

function writeSelection(scope: string, propertyId: string | null) {
  const store = getStore(scope);
  if (store.value === propertyId) return;
  store.value = propertyId;
  try {
    if (typeof window !== "undefined") {
      if (propertyId) window.localStorage.setItem(storageKey(scope), propertyId);
      else window.localStorage.removeItem(storageKey(scope));
    }
  } catch {
    // The shared in-memory store still synchronizes all mounted consumers.
  }
  notify(store);
}

export function useRestaurantWorkspace(tenantId?: string) {
  const fn = useServerFn(getRestaurantWorkspaceFn);
  const query = useQuery({
    queryKey: ["restaurant.workspace", tenantId ?? "default"],
    queryFn: () => fn({ data: tenantId ? { tenantId } : {} }),
    staleTime: 60_000,
  });

  const resolvedTenantId = query.data?.tenant?.id ?? tenantId;
  // Until the authenticated workspace resolves, do not read or mutate a
  // cross-tenant selection. The temporary scope is intentionally inert.
  const scope = resolvedTenantId ?? "pending";
  const subscribeToScope = useCallback(
    (listener: () => void) => subscribe(scope, listener),
    [scope],
  );
  const getScopeSnapshot = useCallback(() => getSnapshot(scope), [scope]);
  const storedPropertyId = useSyncExternalStore(
    subscribeToScope,
    getScopeSnapshot,
    getServerSnapshot,
  );

  const properties = query.data?.properties ?? [];
  const storedSelectionIsValid = properties.some((property) => property.id === storedPropertyId);

  // Reconcile only after the server has returned the allowed property list.
  // This prevents stale/cross-tenant local storage from becoming active.
  useEffect(() => {
    if (!query.data || !resolvedTenantId) return;
    if (storedSelectionIsValid) return;
    writeSelection(resolvedTenantId, properties[0]?.id ?? null);
  }, [query.data, resolvedTenantId, storedSelectionIsValid, properties]);

  const activeProperty = storedSelectionIsValid
    ? properties.find((property) => property.id === storedPropertyId) ?? null
    : properties[0] ?? null;

  const selectProperty = useCallback(
    (propertyId: string) => {
      if (!resolvedTenantId || !properties.some((property) => property.id === propertyId)) return;
      writeSelection(resolvedTenantId, propertyId);
    },
    [resolvedTenantId, properties],
  );

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
