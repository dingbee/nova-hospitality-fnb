import { describe, expect, it } from "vitest";
import { resolveOperatingContext } from "./tenancy.server";

const P1 = "property-1";
const P2 = "property-2";
const O1 = "outlet-1";
const O2 = "outlet-2";

const properties = [{ id: P1 }, { id: P2 }];
const locations = [
  { id: O1, property_id: P1 },
  { id: O2, property_id: P2 },
];

describe("canonical restaurant operating context", () => {
  it("pins a single-property caller to its only accessible property and outlet", () => {
    expect(
      resolveOperatingContext([{ id: P2 }], [{ id: O2, property_id: P2 }]),
    ).toEqual({ activePropertyId: P2, activeLocationId: O2 });
  });

  it("honours an explicit property and outlet within that property", () => {
    expect(resolveOperatingContext(properties, locations, P2, O2)).toEqual({
      activePropertyId: P2,
      activeLocationId: O2,
    });
  });

  it("rejects a property outside the caller's already-filtered accessible set", () => {
    expect(() => resolveOperatingContext([{ id: P1 }], [{ id: O1, property_id: P1 }], P2)).toThrow(
      /outside your restaurant access scope/,
    );
  });

  it("rejects an outlet outside the caller's accessible set", () => {
    expect(() => resolveOperatingContext([{ id: P1 }], [{ id: O1, property_id: P1 }], P1, O2)).toThrow(
      /outside your restaurant access scope/,
    );
  });

  it("rejects an outlet belonging to a different selected property", () => {
    expect(() => resolveOperatingContext(properties, locations, P1, O2)).toThrow(
      /does not belong to the selected property/,
    );
  });

  it("does not invent a multi-property context when no selection exists", () => {
    expect(resolveOperatingContext(properties, locations)).toEqual({
      activePropertyId: null,
      activeLocationId: null,
    });
  });
});
