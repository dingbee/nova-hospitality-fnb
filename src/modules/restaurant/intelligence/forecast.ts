/**
 * P05 §8 — Forecasting.
 *
 * The ONE shared deterministic forecasting utility for P05. Demand,
 * Revenue and Inventory-requirement forecasting all call this same
 * function against their own daily series rather than each carrying its
 * own projection math — satisfying the master prompt's explicit "do NOT
 * create a second forecasting engine" (existing prior art:
 * purchasing.server.ts's `recommendedPurchaseQuantity` is a narrower,
 * inventory-specific sibling of the same idea — a straight-line
 * projection of an observed rate — and is left untouched here).
 *
 * Method: ordinary least-squares linear regression over the daily series
 * (index 0..n-1 vs value), projected forward for `horizonDays`. This is
 * "a straight-line projection of an observed trend": no model, no AI,
 * fully reproducible from the same inputs. When the trend line would
 * imply a negative value, it is floored at 0 — a restaurant cannot sell
 * negative covers.
 *
 * Every result names its horizon, historical basis, assumptions and
 * limitations, and its data-sufficiency band — so a caller can decide
 * whether to actually show the projected numbers or just the
 * observations, per P05 §8's "do not create false precision" rule.
 */
import { assessDataSufficiency, isUsableSufficiency, type DataSufficiency } from "./sufficiency";
import { round } from "./analysis";

export interface DailyPoint {
  date: string;
  value: number;
}

export interface ForecastPoint {
  date: string;
  projected: number;
}

export interface ForecastResult {
  method: "linear_trend" | "insufficient_data";
  horizonDays: number;
  historicalBasisDays: number;
  sufficiency: DataSufficiency;
  /** Average daily value over the observed history — the flat baseline the trend line adjusts. */
  dailyAverage: number | null;
  /** Change per day implied by the regression line. Positive = growing, negative = declining. */
  trendPerDay: number | null;
  /** Sum of `points`, i.e. the total the trend implies over the whole horizon. Null when insufficient data. */
  horizonTotal: number | null;
  points: ForecastPoint[];
  assumptions: string[];
  limitations: string[];
}

function nextDateIso(baseIso: string, offsetDays: number): string {
  const d = new Date(baseIso);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * `daily` must be a complete, gap-filled series (one point per calendar day,
 * zeros included) ordered oldest-to-newest — callers are responsible for
 * gap-filling their own domain's raw rows before calling this, since only
 * they know what "no activity that day" means for their unit of
 * observation.
 */
export function forecastFromDailySeries(daily: DailyPoint[], horizonDays: number): ForecastResult {
  const n = daily.length;
  const nonZeroDays = daily.filter((d) => d.value > 0).length;
  const sufficiency = assessDataSufficiency(nonZeroDays, n);

  const limitations: string[] = [...sufficiency.reasons];

  if (!isUsableSufficiency(sufficiency.state) || n === 0) {
    return {
      method: "insufficient_data",
      horizonDays,
      historicalBasisDays: n,
      sufficiency: sufficiency.state,
      dailyAverage: null,
      trendPerDay: null,
      horizonTotal: null,
      points: [],
      assumptions: [],
      limitations:
        limitations.length > 0
          ? limitations
          : ["Not enough historical observations to project a trend."],
    };
  }

  // Ordinary least squares over index (0..n-1) vs value.
  const meanX = (n - 1) / 2;
  const meanY = daily.reduce((s, d) => s + d.value, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    num += dx * (daily[i]!.value - meanY);
    den += dx * dx;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;

  const lastDate = daily[n - 1]!.date;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizonDays; h += 1) {
    const raw = intercept + slope * (n - 1 + h);
    points.push({ date: nextDateIso(lastDate, h), projected: round(Math.max(0, raw), 2) });
  }
  const horizonTotal = round(
    points.reduce((s, p) => s + p.projected, 0),
    2,
  );

  if (sufficiency.state === "LIMITED_CONFIDENCE") {
    limitations.push(
      "Projection is based on a short history and may shift materially as more data arrives.",
    );
  }

  return {
    method: "linear_trend",
    horizonDays,
    historicalBasisDays: n,
    sufficiency: sufficiency.state,
    dailyAverage: round(meanY, 3),
    trendPerDay: round(slope, 4),
    horizonTotal,
    points,
    assumptions: [
      "Ordinary least-squares linear trend over the observed daily series.",
      "No seasonality, promotions, or external events are modelled — a straight-line continuation of the recent trend only.",
      "Projected values are floored at zero.",
    ],
    limitations,
  };
}

/** Builds a complete, zero-filled daily series between two ISO dates (inclusive) from a sparse map of date -> value. */
export function fillDailySeries(
  values: Map<string, number>,
  startIso: string,
  endIso: string,
): DailyPoint[] {
  const out: DailyPoint[] = [];
  const start = new Date(startIso.slice(0, 10));
  const end = new Date(endIso.slice(0, 10));
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, value: values.get(iso) ?? 0 });
  }
  return out;
}
