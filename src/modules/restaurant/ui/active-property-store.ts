export const ACTIVE_PROPERTY_STORAGE_KEY = "lexibite.active-property";

export interface PropertyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PropertyListener = () => void;

export interface ActivePropertyStore {
  get(): string | null;
  set(propertyId: string | null, persist?: boolean): void;
  subscribe(listener: PropertyListener): () => void;
  resolve(propertyIds: readonly string[]): string | null;
}

export function resolveActivePropertyId(
  storedId: string | null,
  accessiblePropertyIds: readonly string[],
): string | null {
  if (accessiblePropertyIds.length === 0) return null;
  return storedId && accessiblePropertyIds.includes(storedId)
    ? storedId
    : accessiblePropertyIds[0];
}

/** Store is injectable so persistence, reload hydration, and workspace scoping can be tested. */
export function createActivePropertyStore(
  storage: PropertyStorage | null,
): ActivePropertyStore {
  const listeners = new Set<PropertyListener>();
  let initialized = false;
  let activePropertyId: string | null = null;

  const read = (): string | null => {
    try {
      return storage?.getItem(ACTIVE_PROPERTY_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };

  const persist = (propertyId: string | null) => {
    try {
      if (!storage) return;
      if (propertyId) storage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, propertyId);
      else storage.removeItem(ACTIVE_PROPERTY_STORAGE_KEY);
    } catch {
      // The in-memory selection remains usable when browser storage is unavailable.
    }
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    activePropertyId = read();
  };

  return {
    get() {
      initialize();
      return activePropertyId;
    },
    set(propertyId, shouldPersist = true) {
      initialize();
      if (activePropertyId === propertyId) {
        if (shouldPersist) persist(propertyId);
        return;
      }
      activePropertyId = propertyId;
      if (shouldPersist) persist(propertyId);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      initialize();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve(accessiblePropertyIds) {
      initialize();
      // Workspace data is not ready yet (or the response has no properties).
      // Keep the persisted preference until a non-empty authorized list exists.
      if (accessiblePropertyIds.length === 0) return null;
      const resolved = resolveActivePropertyId(activePropertyId, accessiblePropertyIds);
      if (resolved !== activePropertyId) this.set(resolved);
      else if (resolved && read() !== resolved) persist(resolved);
      return resolved;
    },
  };
}
