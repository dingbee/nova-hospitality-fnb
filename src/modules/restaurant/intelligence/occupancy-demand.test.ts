import { describe, expect, it } from "vitest";
import { forecastOccupancyDrivenDemand } from "./occupancy-demand";

const base = {
  mealPeriod: "breakfast" as const,
  expectedInHouseGuests: 40,
  historicalCaptureRate: 0.65,
  averageSpendPerCover: 12000,
  outletCapacity: 100,
  outletOpen: true,
  currency: "TZS",
  historyDays: 120,
};

describe("LB-04 occupancy-driven demand baseline", () => {
  it("increases covers and revenue when expected in-house guests increase", () => {
    const low = forecastOccupancyDrivenDemand(base);
    const high = forecastOccupancyDrivenDemand({ ...base, expectedInHouseGuests: 80 });
    expect(low.expectedCovers).toBe(26);
    expect(high.expectedCovers).toBe(52);
    expect(high.expectedRevenue).toBeGreaterThan(low.expectedRevenue!);
  });

  it("caps demand at configured outlet capacity", () => {
    const result = forecastOccupancyDrivenDemand({
      ...base,
      expectedInHouseGuests: 400,
      outletCapacity: 90,
    });
    expect(result.expectedCovers).toBe(90);
  });

  it("does not invent a capture rate when history is missing", () => {
    const result = forecastOccupancyDrivenDemand({
      ...base,
      historicalCaptureRate: null,
    });
    expect(result.method).toBe("insufficient_data");
    expect(result.expectedCovers).toBeNull();
  });

  it("returns zero demand for a closed outlet", () => {
    const result = forecastOccupancyDrivenDemand({ ...base, outletOpen: false });
    expect(result.expectedCovers).toBe(0);
    expect(result.expectedRevenue).toBe(0);
  });

  it("rejects invalid currencies and capture rates", () => {
    expect(() => forecastOccupancyDrivenDemand({ ...base, currency: "USD/TZS" })).toThrow();
    expect(() =>
      forecastOccupancyDrivenDemand({ ...base, historicalCaptureRate: 1.2 }),
    ).not.toThrow();
    expect(
      forecastOccupancyDrivenDemand({ ...base, historicalCaptureRate: 1.2 }).method,
    ).toBe("insufficient_data");
  });
});
