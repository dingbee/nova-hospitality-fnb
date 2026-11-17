import { describe, expect, it } from "vitest";
import { assessDataSufficiency, isUsableSufficiency } from "./sufficiency";

describe("assessDataSufficiency", () => {
  it("returns NO_DATA for zero samples", () => {
    const r = assessDataSufficiency(0, 0);
    expect(r.state).toBe("NO_DATA");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("returns INSUFFICIENT_DATA below the limited thresholds", () => {
    expect(assessDataSufficiency(2, 10).state).toBe("INSUFFICIENT_DATA");
    expect(assessDataSufficiency(10, 1).state).toBe("INSUFFICIENT_DATA");
  });

  it("returns LIMITED_CONFIDENCE between limited and sufficient thresholds", () => {
    expect(assessDataSufficiency(10, 5).state).toBe("LIMITED_CONFIDENCE");
  });

  it("returns SUFFICIENT_DATA between sufficient and high thresholds", () => {
    expect(assessDataSufficiency(25, 15).state).toBe("SUFFICIENT_DATA");
  });

  it("returns HIGH_CONFIDENCE once both thresholds clear the high bar", () => {
    expect(assessDataSufficiency(100, 40).state).toBe("HIGH_CONFIDENCE");
  });

  it("requires BOTH sample size and distinct days to advance a band", () => {
    // Huge sample count but only 2 distinct days — still insufficient.
    const r = assessDataSufficiency(500, 2);
    expect(r.state).toBe("INSUFFICIENT_DATA");
  });

  it("clears reasons once HIGH_CONFIDENCE is reached", () => {
    const r = assessDataSufficiency(200, 60);
    expect(r.reasons).toEqual([]);
  });

  it("isUsableSufficiency is false only for NO_DATA/INSUFFICIENT_DATA", () => {
    expect(isUsableSufficiency("NO_DATA")).toBe(false);
    expect(isUsableSufficiency("INSUFFICIENT_DATA")).toBe(false);
    expect(isUsableSufficiency("LIMITED_CONFIDENCE")).toBe(true);
    expect(isUsableSufficiency("SUFFICIENT_DATA")).toBe(true);
    expect(isUsableSufficiency("HIGH_CONFIDENCE")).toBe(true);
  });
});
