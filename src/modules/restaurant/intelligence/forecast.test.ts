import { describe, expect, it } from "vitest";
import { fillDailySeries, forecastFromDailySeries } from "./forecast";

function series(values: number[], startIso = "2026-01-01"): { date: string; value: number }[] {
  const start = new Date(startIso);
  return values.map((value, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), value };
  });
}

describe("forecastFromDailySeries", () => {
  it("returns insufficient_data for an empty series", () => {
    const r = forecastFromDailySeries([], 7);
    expect(r.method).toBe("insufficient_data");
    expect(r.points).toEqual([]);
    expect(r.horizonTotal).toBeNull();
    expect(r.limitations.length).toBeGreaterThan(0);
  });

  it("returns insufficient_data for a handful of non-zero days", () => {
    const r = forecastFromDailySeries(series([1, 0, 2, 0, 0]), 7);
    expect(r.method).toBe("insufficient_data");
  });

  it("projects a flat trend for a constant series", () => {
    const flat = series(new Array(30).fill(10));
    const r = forecastFromDailySeries(flat, 5);
    expect(r.method).toBe("linear_trend");
    expect(r.dailyAverage).toBe(10);
    expect(r.trendPerDay).toBeCloseTo(0, 5);
    expect(r.points).toHaveLength(5);
    for (const p of r.points) expect(p.projected).toBeCloseTo(10, 1);
  });

  it("projects a rising trend for a linearly increasing series", () => {
    const rising = series(Array.from({ length: 30 }, (_, i) => i + 1));
    const r = forecastFromDailySeries(rising, 3);
    expect(r.method).toBe("linear_trend");
    expect(r.trendPerDay).toBeGreaterThan(0);
    // Day 31, 32, 33 should each exceed the last observed value (30).
    for (const p of r.points) expect(p.projected).toBeGreaterThan(30);
  });

  it("floors projected values at zero for a steeply declining series", () => {
    const declining = series(Array.from({ length: 30 }, (_, i) => Math.max(0, 30 - i * 3)));
    const r = forecastFromDailySeries(declining, 10);
    for (const p of r.points) expect(p.projected).toBeGreaterThanOrEqual(0);
  });

  it("dates in points continue sequentially from the last historical date", () => {
    const flat = series(new Array(20).fill(5), "2026-02-01");
    const r = forecastFromDailySeries(flat, 3);
    expect(r.points.map((p) => p.date)).toEqual(["2026-02-21", "2026-02-22", "2026-02-23"]);
  });

  it("horizonTotal is the sum of the projected points", () => {
    const flat = series(new Array(20).fill(4));
    const r = forecastFromDailySeries(flat, 5);
    const sum = r.points.reduce((s, p) => s + p.projected, 0);
    expect(r.horizonTotal).toBeCloseTo(sum, 5);
  });
});

describe("fillDailySeries", () => {
  it("zero-fills days with no observation", () => {
    const values = new Map([["2026-01-02", 5]]);
    const out = fillDailySeries(values, "2026-01-01", "2026-01-03");
    expect(out).toEqual([
      { date: "2026-01-01", value: 0 },
      { date: "2026-01-02", value: 5 },
      { date: "2026-01-03", value: 0 },
    ]);
  });
});
