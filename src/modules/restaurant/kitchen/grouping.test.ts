import { describe, expect, it } from "vitest";
import { groupItemsByStation } from "./grouping";

type Item = { id: string; station_id: string | null };

describe("groupItemsByStation — mixed-order ticket split", () => {
  it("a pure beverage order produces exactly one BAR group", () => {
    const items: Item[] = [
      { id: "i1", station_id: "bar-1" },
      { id: "i2", station_id: "bar-1" },
    ];
    const groups = groupItemsByStation(items);
    expect(groups.size).toBe(1);
    expect(
      groups
        .get("bar-1")
        ?.map((i) => i.id)
        .sort(),
    ).toEqual(["i1", "i2"]);
  });

  it("a pure food order produces exactly one KITCHEN group", () => {
    const items: Item[] = [{ id: "i1", station_id: "kitchen-1" }];
    const groups = groupItemsByStation(items);
    expect(groups.size).toBe(1);
    expect(groups.get("kitchen-1")?.map((i) => i.id)).toEqual(["i1"]);
  });

  it("a mixed order splits into one KITCHEN group and one BAR group, with no duplication and no loss", () => {
    const items: Item[] = [
      { id: "food-1", station_id: "kitchen-1" },
      { id: "drink-1", station_id: "bar-1" },
      { id: "food-2", station_id: "kitchen-1" },
      { id: "drink-2", station_id: "bar-1" },
    ];
    const groups = groupItemsByStation(items);

    expect(groups.size).toBe(2);
    expect(
      groups
        .get("kitchen-1")
        ?.map((i) => i.id)
        .sort(),
    ).toEqual(["food-1", "food-2"]);
    expect(
      groups
        .get("bar-1")
        ?.map((i) => i.id)
        .sort(),
    ).toEqual(["drink-1", "drink-2"]);

    // No duplication and no loss: every input item appears in exactly one group.
    const allGrouped = [...groups.values()].flat();
    expect(allGrouped).toHaveLength(items.length);
    expect(new Set(allGrouped.map((i) => i.id)).size).toBe(items.length);
  });

  it("an item with no resolved station is grouped as its own 'unassigned' bucket, never silently merged into a real station", () => {
    const items: Item[] = [
      { id: "orphan", station_id: null },
      { id: "drink-1", station_id: "bar-1" },
    ];
    const groups = groupItemsByStation(items);
    expect(groups.size).toBe(2);
    expect(groups.get("unassigned")?.map((i) => i.id)).toEqual(["orphan"]);
    expect(groups.get("bar-1")?.map((i) => i.id)).toEqual(["drink-1"]);
  });

  it("three or more distinct stations each get their own group", () => {
    const items: Item[] = [
      { id: "a", station_id: "kitchen-1" },
      { id: "b", station_id: "bar-1" },
      { id: "c", station_id: "coffee-1" },
    ];
    const groups = groupItemsByStation(items);
    expect(groups.size).toBe(3);
  });
});
