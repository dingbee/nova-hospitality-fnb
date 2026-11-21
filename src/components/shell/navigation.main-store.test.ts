import { describe, expect, it } from "vitest";
import { visibleGroups } from "./navigation";

const labels = (groups: ReturnType<typeof visibleGroups>) =>
  groups.flatMap((g) => g.items.map((i) => i.to));

describe("Main Store navigation", () => {
  it("appears only when central-store mode is active", () => {
    expect(
      labels(visibleGroups(["INVENTORY:READ"], false, { centralStoreActive: true })),
    ).toContain("/admin/restaurant/main-store");
    expect(
      labels(visibleGroups(["INVENTORY:READ"], false, { centralStoreActive: false })),
    ).not.toContain("/admin/restaurant/main-store");
    expect(labels(visibleGroups(["INVENTORY:READ"]))).not.toContain("/admin/restaurant/main-store");
  });

  it("still requires inventory read permission", () => {
    expect(
      labels(visibleGroups(["PROCUREMENT:READ"], false, { centralStoreActive: true })),
    ).not.toContain("/admin/restaurant/main-store");
  });

  it("does not change any other item's visibility", () => {
    const perms = ["INVENTORY:READ", "PROCUREMENT:READ", "SUPPLIERS:READ"];
    const off = labels(visibleGroups(perms, false, { centralStoreActive: false }));
    const on = labels(visibleGroups(perms, false, { centralStoreActive: true }));
    expect(on.filter((p) => p !== "/admin/restaurant/main-store")).toEqual(off);
  });
});
