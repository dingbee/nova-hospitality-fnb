import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_PROPERTY_STORAGE_KEY,
  createActivePropertyStore,
  resolveActivePropertyId,
  type PropertyStorage,
} from "./active-property-store";

class FakeStorage implements PropertyStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("active property persistence", () => {
  it("rehydrates the selected non-default property after a page reload", () => {
    const storage = new FakeStorage();
    const firstPage = createActivePropertyStore(storage);
    firstPage.resolve(["property-a", "property-b"]);
    firstPage.set("property-b");
    expect(storage.getItem(ACTIVE_PROPERTY_STORAGE_KEY)).toBe("property-b");

    // A reload creates a fresh in-memory store but keeps browser localStorage.
    const reloadedPage = createActivePropertyStore(storage);
    expect(reloadedPage.get()).toBe("property-b");
    expect(reloadedPage.resolve(["property-a", "property-b"])).toBe("property-b");
  });

  it("rejects a stored property that is not accessible in the current workspace", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, "foreign-property");
    const store = createActivePropertyStore(storage);

    expect(store.resolve(["workspace-property-a", "workspace-property-b"])).toBe(
      "workspace-property-a",
    );
    expect(storage.getItem(ACTIVE_PROPERTY_STORAGE_KEY)).toBe("workspace-property-a");
  });

  it("does not erase a persisted selection while workspace data is not yet available", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_PROPERTY_STORAGE_KEY, "property-b");
    const store = createActivePropertyStore(storage);

    expect(store.resolve([])).toBeNull();
    expect(storage.getItem(ACTIVE_PROPERTY_STORAGE_KEY)).toBe("property-b");
    expect(store.resolve(["property-a", "property-b"])).toBe("property-b");
  });

  it("notifies all mounted hook subscribers when the selection changes", () => {
    const store = createActivePropertyStore(new FakeStorage());
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    store.set("property-b");

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("syncs an external storage event without writing back to storage", () => {
    const storage = new FakeStorage();
    const store = createActivePropertyStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("property-a");
    listener.mockClear();

    store.set("property-b", false);

    expect(store.get()).toBe("property-b");
    expect(listener).toHaveBeenCalledOnce();
    expect(storage.getItem(ACTIVE_PROPERTY_STORAGE_KEY)).toBe("property-a");
  });

  it("returns null when the workspace has no accessible properties", () => {
    expect(resolveActivePropertyId("property-a", [])).toBeNull();
  });

  it("degrades safely when browser storage is unavailable", () => {
    const store = createActivePropertyStore(null);

    expect(() => store.set("property-a")).not.toThrow();
    expect(store.get()).toBe("property-a");
  });
});
