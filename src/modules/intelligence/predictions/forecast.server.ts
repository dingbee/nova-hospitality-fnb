/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 4 — Prediction Engine.
 *
 * Deterministic and explainable. Every forecast states its drivers, its
 * confidence and the recommendation it justifies. Predictions are persisted to
 * intelligence_predictions so the Learn stage can score them against reality.
 */
import { assertIntelRead, visibleModules } from "../core/access.server";
import { getBusinessContext } from "../context/context.server";
import type { BusinessContext } from "../context/context.types";
import type {
  Forecast,
  ForecastAccuracy,
  ForecastBoard,
  ForecastDriver,
  RunForecastResult,
} from "./forecast.types";

type Sb = any;

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const ACTIVE = ["confirmed", "checked_in", "checked_out"];

/** Business pattern: how much late pickup a season plus booking pace normally adds. */
const PACE_PICKUP: Record<string, number> = { accelerating: 0.28, steady: 0.16, slowing: 0.07 };
const SEASON_FACTOR: Record<string, number> = { high: 1.3, shoulder: 1.0, low: 0.7 };
/** Housekeeping business rule: turnovers one full shift can absorb in a day. */
const TURNOVER_CAPACITY = 16;

interface OperationalDay {
  date: string;
  arrivals: number;
  departures: number;
  turnovers: number;
}

async function loadOperationalDays(supabase: Sb, horizonDays: number): Promise<OperationalDay[]> {
  const today = new Date();
  const from = iso(today);
  const to = iso(new Date(today.getTime() + horizonDays * DAY));

  const { data } = await supabase
    .from("bookings")
    .select("check_in, check_out, status")
    .in("status", ["confirmed", "checked_in"])
    .or(`and(check_in.gte.${from},check_in.lte.${to}),and(check_out.gte.${from},check_out.lte.${to})`)
    .limit(2000);

  const map = new Map<string, OperationalDay>();
  for (let i = 0; i <= horizonDays; i += 1) {
    const d = iso(new Date(today.getTime() + i * DAY));
    map.set(d, { date: d, arrivals: 0, departures: 0, turnovers: 0 });
  }
  for (const b of (data ?? []) as any[]) {
    const arr = map.get(String(b.check_in));
    if (arr) arr.arrivals += 1;
    const dep = map.get(String(b.check_out));
    if (dep) dep.departures += 1;
  }
  for (const d of map.values()) d.turnovers = d.arrivals + d.departures;
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function loadMonthRevenue(supabase: Sb) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthStart = iso(new Date(Date.UTC(y, m, 1)));
  const monthEnd = iso(new Date(Date.UTC(y, m + 1, 0)));
  const lyStart = iso(new Date(Date.UTC(y - 1, m, 1)));
  const lyEnd = iso(new Date(Date.UTC(y - 1, m + 1, 0)));
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();

  const sum = async (from: string, to: string) => {
    const { data } = await supabase
      .from("booking_nights")
      .select("nightly_rate")
      .gte("date", from)
      .lte("date", to)
      .limit(20000);
    return round((data ?? []).reduce((s: number, r: any) => s + Number(r.nightly_rate || 0), 0), 0);
  };

  const [monthToDate, onTheBooks, lastYear] = await Promise.all([
    sum(monthStart, iso(now)),
    sum(iso(now), monthEnd),
    sum(lyStart, lyEnd),
  ]);

  return { monthToDate, onTheBooks, lastYear, daysInMonth, dayOfMonth, monthEnd };
}

async function loadUpcomingVips(supabase: Sb, horizonDays: number) {
  const today = new Date();
  const { data } = await supabase
    .from("bookings")
    .select("id, guest_id, check_in, total")
    .in("status", ["confirmed", "checked_in"])
    .gte("check_in", iso(today))
    .lte("check_in", iso(new Date(today.getTime() + horizonDays * DAY)))
    .limit(500);

  const rows = (data ?? []) as any[];
  const guestIds = [...new Set(rows.map((r) => r.guest_id).filter(Boolean))] as string[];
  if (guestIds.length === 0) return { arrivals: rows.length, vip: 0, returning: 0, preferences: [] as string[], nextArrival: null as string | null };

  const [{ data: guests }, { data: history }, { data: prefs }] = await Promise.all([
    supabase.from("guests").select("id, vip_since").in("id", guestIds).not("vip_since", "is", null),
    supabase.from("bookings").select("guest_id").in("guest_id", guestIds).in("status", ACTIVE).limit(5000),
    supabase.from("guest_preferences").select("key, value").in("guest_id", guestIds).limit(200),
  ]);

  const stays = new Map<string, number>();
  for (const h of (history ?? []) as any[]) stays.set(h.guest_id, (stays.get(h.guest_id) ?? 0) + 1);
  const returning = guestIds.filter((id) => (stays.get(id) ?? 0) >= 2).length;
  const preferences = [
    ...new Set(((prefs ?? []) as any[]).map((p) => `${p.key}${p.value ? `: ${p.value}` : ""}`)),
  ].slice(0, 5);
  const vipIds = new Set(((guests ?? []) as any[]).map((g) => g.id));
  const nextVip = rows
    .filter((r) => vipIds.has(r.guest_id))
    .sort((a, b) => String(a.check_in).localeCompare(String(b.check_in)))[0];

  return {
    arrivals: rows.length,
    vip: vipIds.size,
    returning,
    preferences,
    nextArrival: nextVip ? String(nextVip.check_in) : null,
  };
}

function pct(n: number) {
  return `${n > 0 ? "+" : ""}${Math.round(n)}%`;
}

/** Pure forecast synthesis — context and operational data in, predictions out. */
export function buildForecasts(
  ctx: BusinessContext,
  data: {
    horizonDays: number;
    operationalDays: OperationalDay[];
    revenue: Awaited<ReturnType<typeof loadMonthRevenue>>;
    guests: Awaited<ReturnType<typeof loadUpcomingVips>>;
  },
): Forecast[] {
  const { horizonDays, operationalDays, revenue, guests } = data;
  const targetDate = iso(new Date(Date.now() + horizonDays * DAY));
  const out: Forecast[] = [];

  const avoidsDiscounting = ctx.memory.strategic.some((m) =>
    /discount|rate integrity|no promo/i.test(`${m.key} ${m.value}`),
  );
  const learnedLine = ctx.memory.learned[0]?.value ?? null;

  /* ---------------- 1. Demand forecasting ---------------- */
  const paceFactor = PACE_PICKUP[ctx.revenue.booking_pace] ?? 0.16;
  const seasonFactor = SEASON_FACTOR[ctx.seasonal.season] ?? 1;
  const yoyFactor = ctx.seasonal.yoy_delta_pct === null ? 1 : clamp(1 + ctx.seasonal.yoy_delta_pct / 300, 0.85, 1.2);
  const pickup = paceFactor * seasonFactor * yoyFactor;
  const onTheBooks = ctx.occupancy.forecast;
  const expectedOccupancy = round(clamp(onTheBooks * (1 + pickup), 0, 100));
  const spread = round(clamp(expectedOccupancy * (0.12 + (1 - ctx.occupancy.confidence) * 0.2), 3, 25));
  const demandDrivers: ForecastDriver[] = [
    { label: "On the books", detail: `${onTheBooks}% of ${ctx.occupancy.rooms_total} rooms already sold over ${horizonDays} days`, weight: 0.45 },
    { label: "Booking pace", detail: `Pace is ${ctx.revenue.booking_pace}, historically adding ${Math.round(paceFactor * 100)}% late pickup`, weight: ctx.revenue.booking_pace === "slowing" ? -0.2 : 0.25 },
    { label: "Seasonality", detail: `${ctx.seasonal.month} is ${ctx.seasonal.season} season — ${ctx.seasonal.pattern}`, weight: seasonFactor >= 1.2 ? 0.2 : seasonFactor <= 0.8 ? -0.15 : 0.05 },
    { label: "Historical average", detail: `90-day average occupancy is ${ctx.occupancy.historical_average}%`, weight: 0.1 },
  ];
  if (ctx.seasonal.yoy_delta_pct !== null) {
    demandDrivers.push({
      label: "Year on year",
      detail: `Month-to-date reservations are ${pct(ctx.seasonal.yoy_delta_pct)} versus last year`,
      weight: clamp(ctx.seasonal.yoy_delta_pct / 100, -0.2, 0.2),
    });
  }
  const demandUp = expectedOccupancy > ctx.occupancy.historical_average + 3;
  const demandConfidence = round(clamp((ctx.occupancy.confidence * 0.7 + ctx.seasonal.confidence * 0.3) + 0.05, 0.3, 0.95), 2);
  out.push({
    key: "forecast.demand.occupancy",
    kind: "demand",
    module: "revenue",
    label: `Expected occupancy in ${horizonDays} days`,
    horizonDays,
    targetDate,
    predictedValue: expectedOccupancy,
    lowerBound: round(clamp(expectedOccupancy - spread, 0, 100)),
    upperBound: round(clamp(expectedOccupancy + spread, 0, 100)),
    unit: "%",
    baselineValue: ctx.occupancy.current,
    direction: expectedOccupancy > ctx.occupancy.current + 2 ? "up" : expectedOccupancy < ctx.occupancy.current - 2 ? "down" : "flat",
    severity: demandUp ? "medium" : "info",
    confidence: demandConfidence,
    statement:
      `Based on current booking velocity, ${ctx.seasonal.season}-season pattern and historical performance, Legacy is likely to reach ` +
      `${expectedOccupancy}% occupancy over the next ${horizonDays} days (range ${round(clamp(expectedOccupancy - spread, 0, 100))}–${round(clamp(expectedOccupancy + spread, 0, 100))}%), ` +
      `up from ${ctx.occupancy.current}% today. Confidence: ${Math.round(demandConfidence * 100)}%.` +
      (learnedLine ? ` Learned pattern applied: ${learnedLine}` : ""),
    drivers: demandDrivers,
    reasoningSources: ["on_the_books", "booking_pace", "seasonal_pattern", "historical_occupancy", ...(ctx.seasonal.yoy_delta_pct !== null ? ["yoy_comparison"] : [])],
    recommendation: demandUp
      ? {
          title: "Protect premium pricing while demand builds",
          suggestedAction: avoidsDiscounting
            ? "Hold rate on the strongest dates, close the lowest rate plans, and push direct conversion through the website and pre-arrival messaging."
            : "Close the lowest rate plans on the strongest dates and prioritise direct-channel conversion before inventory thins.",
          actionType: "revenue.review_pricing",
          impact: `Protects ADR while occupancy climbs toward ${expectedOccupancy}%`,
        }
      : {
          title: "Generate demand for the softer window",
          suggestedAction: avoidsDiscounting
            ? "Increase marketing reach and add value inclusions on the softest dates — management preference is to protect rate integrity."
            : "Open promotional inventory on the softest dates and re-target previous guests who stayed in this season.",
          actionType: "marketing.launch_campaign",
          impact: "Closes the occupancy gap before lead time runs out",
        },
    evidence: { on_the_books: onTheBooks, pickup_factor: round(pickup, 2), occupancy: ctx.occupancy, seasonal: ctx.seasonal },
  });

  /* ---------------- 2. Revenue forecasting ---------------- */
  const remainingDays = Math.max(0, revenue.daysInMonth - revenue.dayOfMonth);
  const roomsTotal = ctx.occupancy.rooms_total;
  const expectedNightlyRevenue = round((expectedOccupancy / 100) * roomsTotal * (ctx.revenue.adr || ctx.revenue.adr_baseline), 0);
  const projected = round(revenue.monthToDate + Math.max(revenue.onTheBooks, expectedNightlyRevenue * remainingDays * 0.85), 0);
  const target = revenue.lastYear > 0 ? revenue.lastYear : round(ctx.revenue.adr_baseline * roomsTotal * revenue.daysInMonth * (ctx.occupancy.historical_average / 100), 0);
  const gap = target > 0 ? round(((projected - target) / target) * 100) : 0;
  const revenueConfidence = round(clamp(ctx.revenue.confidence * 0.75 + ctx.occupancy.confidence * 0.25, 0.3, 0.9), 2);
  const shortfall = gap <= -5;
  out.push({
    key: "forecast.revenue.month_close",
    kind: "revenue",
    module: "finance",
    label: `Projected ${ctx.seasonal.month} revenue`,
    horizonDays: remainingDays,
    targetDate: revenue.monthEnd,
    predictedValue: projected,
    lowerBound: round(projected * 0.9, 0),
    upperBound: round(projected * 1.1, 0),
    unit: ctx.revenue.currency,
    baselineValue: target,
    direction: gap > 3 ? "up" : gap < -3 ? "down" : "flat",
    severity: gap <= -10 ? "high" : shortfall ? "medium" : "info",
    confidence: revenueConfidence,
    statement:
      `Current ADR trajectory (${ctx.revenue.currency} ${ctx.revenue.adr} versus a ${ctx.revenue.currency} ${ctx.revenue.adr_baseline} baseline) and ` +
      `${expectedOccupancy}% expected occupancy suggest ${ctx.seasonal.month} will finish around ${ctx.revenue.currency} ${projected.toLocaleString()} — ` +
      `${gap === 0 ? "in line with" : `${pct(gap)} versus`} the ${ctx.revenue.currency} ${target.toLocaleString()} reference. Confidence: ${Math.round(revenueConfidence * 100)}%.`,
    drivers: [
      { label: "Month to date", detail: `${ctx.revenue.currency} ${revenue.monthToDate.toLocaleString()} recognised so far`, weight: 0.4 },
      { label: "On the books", detail: `${ctx.revenue.currency} ${revenue.onTheBooks.toLocaleString()} already reserved for the rest of the month`, weight: 0.3 },
      { label: "ADR position", detail: `ADR is ${ctx.revenue.adr_position.replace("_", " ")} (risk: ${ctx.revenue.risk})`, weight: ctx.revenue.risk === "underpricing" ? -0.2 : 0.15 },
      { label: "Expected occupancy", detail: `${expectedOccupancy}% forecast across ${roomsTotal} rooms for ${remainingDays} remaining days`, weight: 0.25 },
    ],
    reasoningSources: ["month_to_date_revenue", "on_the_books_revenue", "adr_position", "occupancy_forecast", "yoy_comparison"],
    recommendation: shortfall
      ? {
          title: "Close the projected revenue gap",
          suggestedAction: avoidsDiscounting
            ? "Drive direct conversion and upsell room categories and extras rather than discounting — rate integrity is a standing management preference."
            : "Prioritise conversion on the softest dates and review rate plans where ADR is trailing baseline.",
          actionType: "revenue.review_pricing",
          impact: `Recovers roughly ${ctx.revenue.currency} ${Math.abs(round(target - projected, 0)).toLocaleString()} against the reference`,
        }
      : {
          title: "Hold the plan and protect yield",
          suggestedAction: "Keep premium inventory open for late high-rate demand and avoid opening discounted plans this month.",
          actionType: "revenue.review_inventory",
          impact: "Converts a strong month into higher yield",
        },
    evidence: { projected, target, gap_pct: gap, month_to_date: revenue.monthToDate, on_the_books: revenue.onTheBooks },
  });

  /* ---------------- 3. Operational risk ---------------- */
  const peak = [...operationalDays].sort((a, b) => b.turnovers - a.turnovers)[0];
  if (peak && peak.turnovers > 0) {
    const overCapacity = peak.turnovers > TURNOVER_CAPACITY;
    const dayName = new Date(`${peak.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
    const opsConfidence = round(clamp(0.55 + Math.min(0.3, peak.turnovers / 40), 0.4, 0.9), 2);
    out.push({
      key: "forecast.operations.housekeeping_load",
      kind: "operational_risk",
      module: "operations",
      label: "Peak housekeeping workload",
      horizonDays,
      targetDate: peak.date,
      predictedValue: peak.turnovers,
      lowerBound: peak.turnovers,
      upperBound: peak.turnovers + Math.round(peak.turnovers * 0.15),
      unit: "turnovers",
      baselineValue: TURNOVER_CAPACITY,
      direction: overCapacity ? "up" : "flat",
      severity: overCapacity ? (peak.turnovers > TURNOVER_CAPACITY * 1.4 ? "high" : "medium") : "info",
      confidence: opsConfidence,
      statement: overCapacity
        ? `Housekeeping workload is likely to exceed capacity on ${dayName}: ${peak.arrivals} arrivals and ${peak.departures} departures give ${peak.turnovers} room turnovers against a ${TURNOVER_CAPACITY}-turnover single-shift capacity. Confidence: ${Math.round(opsConfidence * 100)}%.`
        : `Busiest operational day in the window is ${dayName} with ${peak.turnovers} turnovers (${peak.arrivals} arrivals, ${peak.departures} departures) — within the ${TURNOVER_CAPACITY}-turnover shift capacity. Confidence: ${Math.round(opsConfidence * 100)}%.`,
      drivers: [
        { label: "Arrivals", detail: `${peak.arrivals} confirmed arrivals on ${peak.date}`, weight: 0.4 },
        { label: "Departures", detail: `${peak.departures} departures requiring full turnover`, weight: 0.4 },
        { label: "Shift capacity", detail: `Standard shift absorbs about ${TURNOVER_CAPACITY} turnovers per day`, weight: -0.2 },
      ],
      reasoningSources: ["arrival_schedule", "departure_schedule", "housekeeping_capacity_rule"],
      recommendation: overCapacity
        ? {
            title: `Add housekeeping cover for ${dayName}`,
            suggestedAction: "Roster additional housekeeping cover, stagger check-out reminders and pre-clean stay-over rooms the day before.",
            actionType: "operations.adjust_staffing",
            impact: "Prevents late room readiness and arrival delays on the peak day",
          }
        : null,
      evidence: { peak, capacity: TURNOVER_CAPACITY, days: operationalDays.filter((d) => d.turnovers > 0).slice(0, 14) },
    });
  }

  /* ---------------- 4. Guest experience ---------------- */
  if (guests.vip > 0 || guests.returning > 0) {
    const geConfidence = round(clamp(ctx.guest.confidence + 0.05, 0.35, 0.95), 2);
    out.push({
      key: "forecast.guest.service_preparation",
      kind: "guest_experience",
      module: "guest",
      label: "High-expectation arrivals in the window",
      horizonDays,
      targetDate: guests.nextArrival ?? targetDate,
      predictedValue: guests.vip + guests.returning,
      lowerBound: null,
      upperBound: null,
      unit: "guests",
      baselineValue: guests.arrivals,
      direction: "up",
      severity: guests.vip >= 2 ? "high" : "medium",
      confidence: geConfidence,
      statement:
        `${guests.vip} VIP and ${guests.returning} returning guests are due within the next ${horizonDays} days out of ${guests.arrivals} arrivals` +
        (guests.nextArrival ? `, the first on ${guests.nextArrival}` : "") +
        `. Stored preferences are on file${guests.preferences.length ? ` (${guests.preferences.join(", ")})` : ""}, so service preparation materially affects satisfaction. Confidence: ${Math.round(geConfidence * 100)}%.`,
      drivers: [
        { label: "VIP arrivals", detail: `${guests.vip} guests flagged VIP`, weight: 0.4 },
        { label: "Returning guests", detail: `${guests.returning} guests with two or more previous stays`, weight: 0.3 },
        { label: "Stored preferences", detail: guests.preferences.length ? guests.preferences.join(", ") : "No preferences recorded yet", weight: guests.preferences.length ? 0.2 : -0.1 },
        { label: "Occupancy pressure", detail: `${expectedOccupancy}% expected occupancy constrains room allocation flexibility`, weight: 0.1 },
      ],
      reasoningSources: ["arrival_schedule", "guest_history", "guest_preferences", "occupancy_forecast"],
      recommendation: {
        title: "Prepare service for high-expectation arrivals",
        suggestedAction:
          "Assign preferred rooms now, brief housekeeping and front desk on stored preferences, and send personalised pre-arrival notes.",
        actionType: "guest.vip_prearrival",
        impact: "Protects repeat-guest loyalty and review scores",
      },
      evidence: { guests, expected_occupancy: expectedOccupancy },
    });
  }

  return out;
}

function headlineFor(forecasts: Forecast[]): string {
  const demand = forecasts.find((f) => f.kind === "demand");
  const revenue = forecasts.find((f) => f.kind === "revenue");
  if (!demand) return "Not enough data yet to forecast the next two weeks.";
  return `${demand.statement}${revenue ? ` ${revenue.statement}` : ""}`;
}

async function loadAccuracy(supabase: Sb): Promise<ForecastAccuracy> {
  const { data } = await supabase
    .from("intelligence_predictions")
    .select("prediction_key, accuracy")
    .not("accuracy", "is", null)
    .order("actual_recorded_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as any[];
  if (rows.length === 0) return { scored: 0, averageAccuracy: null, byKind: [] };
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const list = byKey.get(r.prediction_key) ?? [];
    list.push(Number(r.accuracy));
    byKey.set(r.prediction_key, list);
  }
  const avg = (l: number[]) => round(l.reduce((s, n) => s + n, 0) / l.length, 3);
  return {
    scored: rows.length,
    averageAccuracy: avg(rows.map((r) => Number(r.accuracy))),
    byKind: [...byKey.entries()].map(([predictionKey, list]) => ({
      predictionKey,
      scored: list.length,
      averageAccuracy: avg(list),
    })),
  };
}

export async function gatherForecasts(supabase: Sb, userId: string, horizonDays: number) {
  const ctx = await getBusinessContext(supabase, userId, { windowDays: horizonDays });
  const [operationalDays, revenue, guests] = await Promise.all([
    loadOperationalDays(supabase, horizonDays),
    loadMonthRevenue(supabase),
    loadUpcomingVips(supabase, horizonDays),
  ]);
  return { ctx, forecasts: buildForecasts(ctx, { horizonDays, operationalDays, revenue, guests }) };
}

/** Read-only forecast board for the UI. */
export async function getForecastBoard(
  supabase: Sb,
  userId: string,
  input: { horizonDays?: number } = {},
): Promise<ForecastBoard> {
  await assertIntelRead(supabase, userId);
  const horizonDays = input.horizonDays ?? 14;
  const [{ forecasts }, accuracy] = await Promise.all([
    gatherForecasts(supabase, userId, horizonDays),
    loadAccuracy(supabase),
  ]);
  return {
    generated_at: new Date().toISOString(),
    horizon_days: horizonDays,
    headline: headlineFor(forecasts),
    forecasts,
    accuracy,
  };
}

/**
 * Run the prediction pass: persist predictions and turn each forecast into a
 * prediction-backed recommendation (idempotent per key per day).
 */
export async function runForecastPass(
  supabase: Sb,
  userId: string,
  input: { horizonDays?: number; persist?: boolean } = {},
): Promise<RunForecastResult> {
  await assertIntelRead(supabase, userId);
  const horizonDays = input.horizonDays ?? 14;
  const persist = input.persist ?? true;
  const allowed = await visibleModules(supabase, userId);
  const { ctx, forecasts } = await gatherForecasts(supabase, userId, horizonDays);

  const result: RunForecastResult = {
    forecastsProduced: forecasts.length,
    predictionsRecorded: 0,
    recommendationsCreated: 0,
    headline: headlineFor(forecasts),
  };
  if (!persist) return result;

  const day = new Date().toISOString().slice(0, 10);

  for (const f of forecasts) {
    if (!allowed.includes(f.module)) continue;

    // Predict — one prediction per key per day so accuracy scoring stays clean.
    const { data: existingPrediction } = await supabase
      .from("intelligence_predictions")
      .select("id")
      .eq("prediction_key", f.key)
      .gte("created_at", `${day}T00:00:00Z`)
      .maybeSingle();

    let predictionId: string | null = existingPrediction?.id ?? null;
    if (!predictionId) {
      const { data: pred } = await supabase
        .from("intelligence_predictions")
        .insert({
          module: f.module,
          prediction_key: f.key,
          label: f.label,
          horizon_days: f.horizonDays,
          target_date: f.targetDate,
          predicted_value: f.predictedValue,
          predicted_text: f.statement,
          lower_bound: f.lowerBound,
          upper_bound: f.upperBound,
          unit: f.unit,
          confidence: f.confidence,
          model: "prediction-engine-v1",
          inputs: {
            kind: f.kind,
            drivers: f.drivers,
            reasoning_sources: f.reasoningSources,
            baseline: f.baselineValue,
            evidence: f.evidence,
          },
        })
        .select("id")
        .single();
      if (pred) {
        predictionId = pred.id as string;
        result.predictionsRecorded += 1;
      }
    }

    if (!f.recommendation) continue;

    const recKey = `${f.key}.${day}`;
    const { data: existingRec } = await supabase
      .from("intelligence_recommendations")
      .select("id")
      .eq("module", f.module)
      .eq("recommendation_key", recKey)
      .in("status", ["new", "reviewing"])
      .maybeSingle();
    if (existingRec) continue;

    const { error } = await supabase.from("intelligence_recommendations").insert({
      module: f.module,
      recommendation_key: recKey,
      title: f.recommendation.title,
      rationale: `${f.statement}\n\nWhy: ${f.drivers.map((d) => `${d.label} — ${d.detail}`).join("; ")}\n\nContext: ${ctx.narrative.join(" ")}`,
      suggested_action: f.recommendation.suggestedAction,
      action_type: f.recommendation.actionType,
      action_payload: { prediction_id: predictionId, prediction_key: f.key, predicted_value: f.predictedValue, unit: f.unit },
      expected_impact: f.recommendation.impact,
      priority: f.severity === "high" || f.severity === "critical" ? 4 : 3,
      confidence: f.confidence,
      reasoning_sources: ["prediction_engine", ...f.reasoningSources],
      context: ctx as unknown as Record<string, unknown>,
    });
    if (!error) result.recommendationsCreated += 1;
  }

  return result;
}