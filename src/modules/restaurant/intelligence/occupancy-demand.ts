/**
 * LB-04 occupancy-driven F&B demand baseline.
 *
 * Deterministic and explainable: expected in-house guests × observed meal-period
 * capture rate, capped by configured service capacity. This is an estimate, not
 * an AI prediction. Callers must supply property-scoped, verified inputs.
 */
export type MealPeriod = "breakfast" | "lunch" | "dinner" | "bar" | "room_service";

export interface OccupancyDemandInput {
  mealPeriod: MealPeriod;
  expectedInHouseGuests: number;
  historicalCaptureRate: number | null;
  averageSpendPerCover: number | null;
  outletCapacity: number | null;
  outletOpen: boolean;
  currency: string;
  historyDays: number;
}

export interface OccupancyDemandForecast {
  mealPeriod: MealPeriod;
  expectedCovers: number | null;
  expectedRevenue: number | null;
  currency: string;
  method: "occupancy_x_capture_rate" | "closed_outlet" | "insufficient_data";
  reliability: "moderate" | "low" | "insufficient_data";
  assumptions: string[];
  limitations: string[];
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

/**
 * Produces one meal-period forecast. No implicit capture-rate defaults are
 * applied: missing history yields insufficient_data rather than fabricated
 * demand. Currency is carried through unchanged; FX is never performed here.
 */
export function forecastOccupancyDrivenDemand(
  input: OccupancyDemandInput,
): OccupancyDemandForecast {
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new TypeError("currency must be an ISO 4217 code");
  }
  const guests = finiteNonNegative(input.expectedInHouseGuests, "expectedInHouseGuests");
  const historyDays = finiteNonNegative(input.historyDays, "historyDays");

  if (!input.outletOpen) {
    return {
      mealPeriod: input.mealPeriod,
      expectedCovers: 0,
      expectedRevenue: 0,
      currency: input.currency,
      method: "closed_outlet",
      reliability: "moderate",
      assumptions: ["Outlet is configured as closed for this forecast period."],
      limitations: [],
    };
  }

  if (
    input.historicalCaptureRate === null ||
    !Number.isFinite(input.historicalCaptureRate) ||
    input.historicalCaptureRate < 0 ||
    input.historicalCaptureRate > 1 ||
    input.averageSpendPerCover === null ||
    !Number.isFinite(input.averageSpendPerCover) ||
    input.averageSpendPerCover < 0
  ) {
    return {
      mealPeriod: input.mealPeriod,
      expectedCovers: null,
      expectedRevenue: null,
      currency: input.currency,
      method: "insufficient_data",
      reliability: "insufficient_data",
      assumptions: [],
      limitations: ["A valid historical capture rate and average spend are required."],
    };
  }

  const rawCovers = guests * input.historicalCaptureRate;
  const capacity =
    input.outletCapacity === null
      ? null
      : finiteNonNegative(input.outletCapacity, "outletCapacity");
  const covers = Math.round(Math.min(rawCovers, capacity ?? rawCovers) * 100) / 100;
  const revenue = Math.round(covers * input.averageSpendPerCover * 100) / 100;
  const reliability = historyDays >= 90 ? "moderate" : "low";

  return {
    mealPeriod: input.mealPeriod,
    expectedCovers: covers,
    expectedRevenue: revenue,
    currency: input.currency,
    method: "occupancy_x_capture_rate",
    reliability,
    assumptions: [
      "Expected covers equal expected in-house guests multiplied by the observed meal-period capture rate.",
      "Configured outlet capacity caps expected covers.",
      "Average spend per cover is held constant over this forecast period.",
    ],
    limitations: [
      historyDays < 90
        ? "Fewer than 90 days of historical data: low reliability; seasonality is not modelled."
        : "Seasonality, promotions and external events are not modelled.",
      "Forecast is advisory and does not represent actual sales or confirmed reservations.",
    ],
  };
}
