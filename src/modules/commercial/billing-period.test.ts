import { describe, expect, it } from "vitest";
import { currentBillingPeriod, prorateForRemainderOfPeriod } from "./billing-period";

describe("currentBillingPeriod", () => {
  it("returns the first period when now is at or before the anchor", () => {
    const anchor = new Date("2026-01-15T00:00:00Z");
    const p = currentBillingPeriod(anchor, "monthly", anchor);
    expect(p.start.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("advances monthly periods to contain a later date", () => {
    const anchor = new Date("2026-01-15T00:00:00Z");
    const now = new Date("2026-04-20T00:00:00Z");
    const p = currentBillingPeriod(anchor, "monthly", now);
    expect(p.start.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("handles month-end overflow (31st anchor into shorter months) without skipping past `now`", () => {
    const anchor = new Date("2026-01-31T00:00:00Z");
    const now = new Date("2026-03-05T00:00:00Z");
    const p = currentBillingPeriod(anchor, "monthly", now);
    // JS Date's setUTCMonth on the 31st rolls Feb into early March —
    // the walk must still land on a period that actually contains `now`.
    expect(p.start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(p.end.getTime()).toBeGreaterThan(now.getTime());
  });

  it("computes annual periods across a leap year boundary", () => {
    const anchor = new Date("2024-02-29T00:00:00Z"); // leap day
    const now = new Date("2026-06-01T00:00:00Z");
    const p = currentBillingPeriod(anchor, "annual", now);
    expect(p.start.getUTCFullYear()).toBe(2026);
    expect(p.end.getUTCFullYear()).toBe(2027);
    expect(p.start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(p.end.getTime()).toBeGreaterThan(now.getTime());
  });

  it("frames a custom interval as monthly, since there is no configured cadence otherwise", () => {
    const anchor = new Date("2026-01-01T00:00:00Z");
    const p = currentBillingPeriod(anchor, "custom", anchor);
    const days = (p.end.getTime() - p.start.getTime()) / 86400000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });
});

describe("prorateForRemainderOfPeriod", () => {
  const period = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-04-01T00:00:00Z") };

  it("charges the full amount when the charge date is at or before period start", () => {
    expect(prorateForRemainderOfPeriod(310000, period, period.start)).toBe(310000);
  });

  it("charges zero when the charge date is at or after period end", () => {
    expect(prorateForRemainderOfPeriod(310000, period, period.end)).toBe(0);
  });

  it("charges a proportional fraction for a mid-period date", () => {
    // 31-day March; charge on the 16th (00:00) leaves 16 days remaining.
    const chargeDate = new Date("2026-03-16T00:00:00Z");
    const result = prorateForRemainderOfPeriod(310000, period, chargeDate);
    const expectedFraction = 16 / 31;
    expect(result).toBeCloseTo(310000 * expectedFraction, 0);
  });

  it("rounds to 2 decimal places", () => {
    // 22 days remaining of 31 → 100000 * 22/31 = 70967.741935..., rounded to 70967.74.
    const chargeDate = new Date("2026-03-10T00:00:00Z");
    const result = prorateForRemainderOfPeriod(100000, period, chargeDate);
    expect(result).toBe(70967.74);
  });

  it("returns the full amount for a zero-length period (defensive, never divides by zero)", () => {
    const degenerate = { start: period.start, end: period.start };
    expect(prorateForRemainderOfPeriod(50000, degenerate, period.start)).toBe(50000);
  });
});
