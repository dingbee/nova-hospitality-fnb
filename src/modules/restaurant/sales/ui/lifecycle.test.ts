import { describe, expect, it } from "vitest";
import { deriveLifecycle } from "./lifecycle";

/**
 * Regression coverage for GitHub issue #3: `deriveLifecycle` fed the till's
 * primary "Next: {label}" button through a hardcoded NEXT_ACTION_LABEL
 * lookup, so a Bar POS order full of beverages still read "Next: Send to
 * kitchen". `orders.tsx` reads the same `nextActionLabel` independently of
 * PosWorkspace.tsx, so the fix had to live in `deriveLifecycle` itself, not
 * as a one-off override in a single component.
 */
describe("deriveLifecycle — the till's primary action label reflects actual pending stations", () => {
  const order = { status: "open", table_id: "t1" };

  it("SCREENSHOT REPRODUCTION: a Bar POS beverage staged at the till reads 'Send to bar', never 'Send to kitchen'", () => {
    const life = deriveLifecycle({
      order,
      stagedCount: 1,
      stagedStationTypes: ["bar"],
    });
    expect(life.nextAction).toBe("send-to-kitchen");
    expect(life.nextActionLabel).toBe("Send to bar");
    expect(life.nextActionLabel).not.toBe("Send to kitchen");
  });

  it("a food item staged at the till still reads 'Send to kitchen'", () => {
    const life = deriveLifecycle({
      order,
      stagedCount: 1,
      stagedStationTypes: ["kitchen"],
    });
    expect(life.nextActionLabel).toBe("Send to kitchen");
  });

  it("a mixed cart (bar + kitchen) names both stations", () => {
    const life = deriveLifecycle({
      order,
      stagedCount: 2,
      stagedStationTypes: ["bar", "kitchen"],
    });
    expect(life.nextActionLabel).toBe("Send to kitchen & bar");
  });

  it("an already-added-but-unfired server item (status 'ordered') with a resolved station_type also drives the label, not just staged cart lines", () => {
    const life = deriveLifecycle({
      order,
      items: [{ status: "ordered", station_type: "bar" }],
    });
    expect(life.nextAction).toBe("send-to-kitchen");
    expect(life.nextActionLabel).toBe("Send to bar");
  });

  it("falls back to the generic 'Send to kitchen' label when no caller supplies station data (e.g. a summary view with no item join) — unchanged, backward-compatible behavior", () => {
    const life = deriveLifecycle({ order, stagedCount: 1 });
    expect(life.nextAction).toBe("send-to-kitchen");
    expect(life.nextActionLabel).toBe("Send to kitchen");
  });

  it("an empty order still reads 'Add items', unaffected by the station-label change", () => {
    const life = deriveLifecycle({ order });
    expect(life.nextAction).toBe("add-items");
    expect(life.nextActionLabel).toBe("Add items");
  });
});
