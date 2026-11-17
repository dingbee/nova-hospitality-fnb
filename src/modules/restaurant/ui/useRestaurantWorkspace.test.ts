import { describe, expect, it } from "vitest";
import { readAndMigratePropertySelection } from "./useRestaurantWorkspace";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("property preference migration", () => {
  it("prefers an existing tenant-scoped selection", () => {
    const storage = fakeStorage({
      "lexibite.active-property:tenant-1": "property-current",
      "lexibite.active-property": "property-legacy",
    });
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1"))
      .toBe("property-current");
    expect(storage.values.get("lexibite.active-property:tenant-1")).toBe("property-current");
  });

  it("migrates the legacy selection into a tenant-scoped key", () => {
    const storage = fakeStorage({ "lexibite.active-property": "property-legacy" });
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1"))
      .toBe("property-legacy");
    expect(storage.values.get("lexibite.active-property:tenant-1")).toBe("property-legacy");
  });

  it("keeps the legacy value usable when storage writes fail", () => {
    const storage = {
      getItem: (key: string) => key === "lexibite.active-property" ? "property-legacy" : null,
      setItem: () => { throw new Error("storage is read-only"); },
    };
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1"))
      .toBe("property-legacy");
  });

  it("returns null when neither key contains a selection", () => {
    expect(readAndMigratePropertySelection(fakeStorage(), "lexibite.active-property:tenant-1"))
      .toBeNull();
  });
});
