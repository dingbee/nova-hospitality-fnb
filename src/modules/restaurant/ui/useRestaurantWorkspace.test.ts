import { describe, expect, it } from "vitest";
import {
  canSelectProperty,
  operatingProperties,
  readAndMigratePropertySelection,
  resolveActiveProperty,
} from "./useRestaurantWorkspace";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("property preference migration", () => {
  it("prefers an existing tenant-scoped selection", () => {
    const storage = fakeStorage({
      "lexibite.active-property:tenant-1": "property-current",
      "lexibite.active-property": "property-legacy",
    });
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1")).toBe(
      "property-current",
    );
    expect(storage.values.get("lexibite.active-property:tenant-1")).toBe("property-current");
  });

  it("migrates the legacy selection into a tenant-scoped key", () => {
    const storage = fakeStorage({ "lexibite.active-property": "property-legacy" });
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1")).toBe(
      "property-legacy",
    );
    expect(storage.values.get("lexibite.active-property:tenant-1")).toBe("property-legacy");
  });

  it("keeps the legacy value usable when storage writes fail", () => {
    const storage = {
      getItem: (key: string) => (key === "lexibite.active-property" ? "property-legacy" : null),
      setItem: () => {
        throw new Error("storage is read-only");
      },
    };
    expect(readAndMigratePropertySelection(storage, "lexibite.active-property:tenant-1")).toBe(
      "property-legacy",
    );
  });

  it("returns null when neither key contains a selection", () => {
    expect(
      readAndMigratePropertySelection(fakeStorage(), "lexibite.active-property:tenant-1"),
    ).toBeNull();
  });
});

describe("operating property resolution", () => {
  const properties = [
    { id: "prop-a", status: "active" },
    { id: "prop-pending", status: "pending" },
    { id: "prop-b", status: "active" },
    { id: "prop-inactive", status: "inactive" },
  ];

  it("restores a valid stored selection after refresh", () => {
    expect(resolveActiveProperty(properties, "prop-b")).toEqual({
      activeProperty: { id: "prop-b", status: "active" },
      storedSelectionIsValid: true,
    });
  });

  it("never adopts a stale, foreign-tenant or unauthorized stored id", () => {
    for (const stored of ["prop-other-tenant", "deleted-prop", "", null]) {
      expect(resolveActiveProperty(properties, stored)).toEqual({
        activeProperty: { id: "prop-a", status: "active" },
        storedSelectionIsValid: false,
      });
    }
  });

  it("never adopts a pending or inactive property, even if stored", () => {
    expect(resolveActiveProperty(properties, "prop-pending").activeProperty?.id).toBe("prop-a");
    expect(resolveActiveProperty(properties, "prop-inactive").activeProperty?.id).toBe("prop-a");
    expect(resolveActiveProperty(properties, "prop-pending").storedSelectionIsValid).toBe(false);
  });

  it("has no operating context when no property is active", () => {
    expect(
      resolveActiveProperty([{ id: "prop-pending", status: "pending" }], "prop-pending"),
    ).toEqual({ activeProperty: null, storedSelectionIsValid: false });
    expect(resolveActiveProperty([], "prop-a").activeProperty).toBeNull();
  });

  it("rejects selecting a property outside the authorized operational list", () => {
    expect(canSelectProperty(properties, "prop-b")).toBe(true);
    expect(canSelectProperty(properties, "prop-pending")).toBe(false);
    expect(canSelectProperty(properties, "prop-other-tenant")).toBe(false);
  });

  it("treats properties without a status field as operational (older payloads)", () => {
    expect(operatingProperties([{ id: "legacy" }]).map((p) => p.id)).toEqual(["legacy"]);
  });
});
