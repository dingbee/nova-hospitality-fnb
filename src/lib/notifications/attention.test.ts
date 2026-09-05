import { describe, expect, it } from "vitest";
import { diffNewlyActive, formatCountdown } from "./attention";

describe("diffNewlyActive", () => {
  it("reports nothing newly active on the first observation, but still records the baseline", () => {
    const { newlyActive, next } = diffNewlyActive(new Set(), ["sr:1", "bill:2"], false);
    expect(newlyActive).toEqual([]);
    expect(next).toEqual(new Set(["sr:1", "bill:2"]));
  });

  it("reports a key that appears after the baseline as newly active", () => {
    const known = new Set(["sr:1"]);
    const { newlyActive, next } = diffNewlyActive(known, ["sr:1", "sr:2"], true);
    expect(newlyActive).toEqual(["sr:2"]);
    expect(next).toEqual(new Set(["sr:1", "sr:2"]));
  });

  it("does not re-report a key that is still active on a later poll", () => {
    const known = new Set(["sr:1"]);
    const { newlyActive } = diffNewlyActive(known, ["sr:1"], true);
    expect(newlyActive).toEqual([]);
  });

  it("forgets a key once it drops out, so it re-alerts if it becomes active again later", () => {
    const known = new Set(["sr:1"]);
    const gone = diffNewlyActive(known, [], true);
    expect(gone.next).toEqual(new Set());
    const backAgain = diffNewlyActive(gone.next, ["sr:1"], true);
    expect(backAgain.newlyActive).toEqual(["sr:1"]);
  });

  it("reports multiple simultaneous new keys in one diff", () => {
    const { newlyActive } = diffNewlyActive(new Set(), ["a", "b", "c"], true);
    expect(newlyActive.sort()).toEqual(["a", "b", "c"]);
  });

  it("a duplicate event id appearing twice in the same poll is still just one key, not double-counted", () => {
    const { next } = diffNewlyActive(new Set(), ["sr:1", "sr:1"], false);
    expect(next.size).toBe(1);
  });
});

describe("formatCountdown", () => {
  it("formats whole minutes and seconds as mm:ss", () => {
    expect(formatCountdown(272)).toBe("04:32");
  });

  it("pads single-digit minutes and seconds", () => {
    expect(formatCountdown(65)).toBe("01:05");
  });

  it("clamps negative remaining time to 00:00", () => {
    expect(formatCountdown(-5)).toBe("00:00");
  });

  it("rounds fractional seconds", () => {
    expect(formatCountdown(59.6)).toBe("01:00");
  });
});
