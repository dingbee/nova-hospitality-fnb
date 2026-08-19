/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3 — Context Engine.
 *
 *   Current event + Historical data + Business rules + Memory + External context
 *                              ↓
 *                     Business understanding
 *
 * Read-only: the engine never writes to operational tables. It only reads
 * what Booking, PMS, Guest and Revenue already store, then layers the
 * Intelligence Core's curated memory on top.
 */
import { assertIntelRead } from "../core/access.server";
import type {
  BusinessContext,
  ContextTrend,
  GuestContext,
  MemoryContext,
  OccupancyContext,
  RevenueContext,
  SeasonalContext,
} from "./context.types";

type Sb = any;

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p;
const clampConfidence = (samples: number, floor = 0.35) =>
  round(Math.min(0.95, floor + Math.min(1, samples / 40) * 0.6), 2);

/** Business rule: Legacy's seasonal calendar. */
function seasonFor(month: number): "high" | "shoulder" | "low" {
  if ([6, 7, 8, 12, 1].includes(month)) return "high";
  if ([2, 3, 4, 5].includes(month)) return "shoulder";
  return "low";
}

function trendOf(current: number, baseline: number): ContextTrend {
  if (baseline <= 0) return current > 0 ? "increasing" : "stable";
  const delta = ((current - baseline) / baseline) * 100;
  if (delta >= 5) return "increasing";
  if (delta <= -5) return "decreasing";
  return "stable";
}

const ACTIVE = ["confirmed", "checked_in", "checked_out"];

async function buildOccupancy(supabase: Sb, windowDays: number): Promise<OccupancyContext> {
  const { data: rooms } = await supabase.from("rooms").select("total_units").eq("status", "active");
  const roomsTotal = (rooms ?? []).reduce((s: number, r: any) => s + (Number(r.total_units) || 0), 0) || 1;

  const today = new Date();
  const from = iso(new Date(today.getTime() - 90 * DAY));
  const to = iso(new Date(today.getTime() + windowDays * DAY));

  const { data: nights } = await supabase
    .from("booking_nights")
    .select("date, booking_id, bookings!inner(status)")
    .gte("date", from)
    .lte("date", to)
    .in("bookings.status", ACTIVE)
    .limit(20000);

  const rows: any[] = nights ?? [];
  const todayStr = iso(today);
  const forecastEnd = to;
  const histStart = iso(new Date(today.getTime() - 90 * DAY));

  const soldToday = rows.filter((r) => r.date === todayStr).length;
  const forecastRows = rows.filter((r) => r.date > todayStr && r.date <= forecastEnd);
  const histRows = rows.filter((r) => r.date >= histStart && r.date < todayStr);

  const current = round((soldToday / roomsTotal) * 100);
  const forecast = round((forecastRows.length / (roomsTotal * Math.max(1, windowDays))) * 100);
  const historical = round((histRows.length / (roomsTotal * 90)) * 100);

  return {
    current,
    forecast,
    historical_average: historical,
    trend: trendOf(forecast, historical),
    confidence: clampConfidence(rows.length / 10),
    rooms_total: roomsTotal,
    window_days: windowDays,
  };
}

async function buildRevenue(supabase: Sb, windowDays: number): Promise<RevenueContext> {
  const now = Date.now();
  const recentFrom = iso(new Date(now - 30 * DAY));
  const baseFrom = iso(new Date(now - 120 * DAY));

  const { data: nights } = await supabase
    .from("booking_nights")
    .select("date, nightly_rate")
    .gte("date", baseFrom)
    .lte("date", iso(new Date(now)))
    .limit(20000);

  const rows: any[] = nights ?? [];
  const recent = rows.filter((r) => r.date >= recentFrom);
  const baseline = rows.filter((r) => r.date < recentFrom);
  const avg = (list: any[]) =>
    list.length ? round(list.reduce((s, r) => s + Number(r.nightly_rate || 0), 0) / list.length, 2) : 0;

  const adr = avg(recent);
  const adrBaseline = avg(baseline) || adr;

  const { count: paceNow } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(now - 7 * DAY).toISOString());
  const { count: pacePrev } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(now - 14 * DAY).toISOString())
    .lt("created_at", new Date(now - 7 * DAY).toISOString());

  const paceDelta = (pacePrev ?? 0) > 0 ? (((paceNow ?? 0) - (pacePrev ?? 0)) / (pacePrev ?? 1)) * 100 : (paceNow ?? 0) > 0 ? 100 : 0;
  const booking_pace = paceDelta >= 15 ? "accelerating" : paceDelta <= -15 ? "slowing" : "steady";

  const gap = adrBaseline > 0 ? ((adr - adrBaseline) / adrBaseline) * 100 : 0;
  const adr_position = gap <= -7 ? "below_market" : gap >= 7 ? "above_market" : "at_market";
  const risk =
    adr_position === "below_market" && booking_pace === "accelerating"
      ? "underpricing"
      : adr_position === "above_market" && booking_pace === "slowing"
        ? "overpricing"
        : "balanced";

  return {
    adr,
    adr_baseline: adrBaseline,
    adr_position,
    booking_pace,
    revenue_window: windowDays,
    risk,
    currency: "USD",
    confidence: clampConfidence(rows.length / 10),
  };
}

async function buildGuest(supabase: Sb, windowDays: number): Promise<GuestContext> {
  const since = new Date(Date.now() - windowDays * DAY).toISOString();
  const { data: recent } = await supabase
    .from("bookings")
    .select("id, guest_id, total, status, created_at")
    .gte("created_at", since)
    .in("status", ["pending", "confirmed", "checked_in"])
    .limit(500);

  const rows: any[] = recent ?? [];
  const guestIds = [...new Set(rows.map((r) => r.guest_id).filter(Boolean))] as string[];

  let returning = 0;
  let highValue = 0;
  let vip = 0;
  let preferences: string[] = [];

  if (guestIds.length > 0) {
    const { data: history } = await supabase
      .from("bookings")
      .select("guest_id, total, status")
      .in("guest_id", guestIds)
      .in("status", ACTIVE)
      .limit(5000);
    const stays = new Map<string, { count: number; value: number }>();
    for (const h of (history ?? []) as any[]) {
      const cur = stays.get(h.guest_id) ?? { count: 0, value: 0 };
      cur.count += 1;
      cur.value += Number(h.total || 0);
      stays.set(h.guest_id, cur);
    }
    for (const id of guestIds) {
      const s = stays.get(id);
      if (!s) continue;
      if (s.count >= 2) returning += 1;
      if (s.value >= 2000) highValue += 1;
    }

    const { data: guests } = await supabase
      .from("guests")
      .select("id, vip_since")
      .in("id", guestIds)
      .not("vip_since", "is", null);
    vip = (guests ?? []).length;

    const { data: prefs } = await supabase
      .from("guest_preferences")
      .select("key, value")
      .in("guest_id", guestIds)
      .limit(200);
    const tally = new Map<string, number>();
    for (const p of (prefs ?? []) as any[]) {
      const label = `${p.key}${p.value ? `: ${p.value}` : ""}`;
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    preferences = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  }

  return {
    new_reservations: rows.length,
    returning_guests: returning,
    returning_share: rows.length ? round((returning / rows.length) * 100) : 0,
    high_value_guests: highValue,
    top_preferences: preferences,
    vip_arrivals: vip,
    confidence: clampConfidence(rows.length * 2),
  };
}

async function buildSeasonal(supabase: Sb): Promise<SeasonalContext> {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const monthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const lyStart = iso(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)));
  const lyEnd = iso(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())));

  const { count: currentCount } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .gte("check_in", monthStart)
    .in("status", ACTIVE);
  const { count: lyCount } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .gte("check_in", lyStart)
    .lte("check_in", lyEnd)
    .in("status", ACTIVE);

  const season = seasonFor(month);
  const yoy = (lyCount ?? 0) > 0 ? round((((currentCount ?? 0) - (lyCount ?? 0)) / (lyCount ?? 1)) * 100) : null;

  return {
    month: now.toLocaleString("en-GB", { month: "long", timeZone: "UTC" }),
    season,
    same_month_last_year: lyCount ?? 0,
    current_month_to_date: currentCount ?? 0,
    yoy_delta_pct: yoy,
    pattern:
      season === "high"
        ? "Peak season — demand normally builds 30–45 days out."
        : season === "shoulder"
          ? "Shoulder season — demand is lead-time sensitive and responds to marketing."
          : "Low season — volume is driven by regional and repeat guests.",
    confidence: clampConfidence(((currentCount ?? 0) + (lyCount ?? 0)) * 2, 0.3),
  };
}

async function buildMemory(supabase: Sb): Promise<MemoryContext> {
  const { data } = await supabase
    .from("intelligence_memory")
    .select("memory_key, memory_value, confidence, memory_tier, status")
    .eq("status", "accepted")
    .order("confidence", { ascending: false })
    .limit(60);

  const out: MemoryContext = { observed: [], learned: [], strategic: [] };
  for (const m of (data ?? []) as any[]) {
    const tier = (m.memory_tier ?? "observed") as keyof MemoryContext;
    if (!out[tier]) continue;
    out[tier].push({ key: m.memory_key, value: m.memory_value, confidence: Number(m.confidence ?? 0) });
  }
  return out;
}

function narrate(c: Omit<BusinessContext, "narrative" | "generated_at">): string[] {
  const lines: string[] = [];
  lines.push(
    `Occupancy is ${c.occupancy.current}% today with a ${c.occupancy.forecast}% forecast over the next ${c.occupancy.window_days} days, against a ${c.occupancy.historical_average}% 90-day average (${c.occupancy.trend}).`,
  );
  lines.push(
    `ADR is ${c.revenue.currency} ${c.revenue.adr} versus a ${c.revenue.currency} ${c.revenue.adr_baseline} baseline — ${c.revenue.adr_position.replace("_", " ")} with ${c.revenue.booking_pace} booking pace (risk: ${c.revenue.risk}).`,
  );
  if (c.guest.new_reservations > 0) {
    lines.push(
      `${c.guest.new_reservations} new reservations, ${c.guest.returning_guests} from returning guests (${c.guest.returning_share}%), ${c.guest.high_value_guests} high-value and ${c.guest.vip_arrivals} VIP.`,
    );
  }
  lines.push(
    `${c.seasonal.month} is ${c.seasonal.season} season. ${c.seasonal.pattern}` +
      (c.seasonal.yoy_delta_pct !== null ? ` Year on year, month-to-date is ${c.seasonal.yoy_delta_pct > 0 ? "+" : ""}${c.seasonal.yoy_delta_pct}%.` : ""),
  );
  if (c.memory.strategic.length > 0) {
    lines.push(`Management preferences in force: ${c.memory.strategic.map((m) => m.value).join(" · ")}`);
  }
  if (c.memory.learned.length > 0) {
    lines.push(`Learned patterns applied: ${c.memory.learned.map((m) => m.value).slice(0, 3).join(" · ")}`);
  }
  return lines;
}

/** Aggregate the full business context. */
export async function getBusinessContext(
  supabase: Sb,
  userId: string,
  input: { windowDays?: number } = {},
): Promise<BusinessContext> {
  await assertIntelRead(supabase, userId);
  const windowDays = input.windowDays ?? 14;
  const [occupancy, revenue, guest, seasonal, memory] = await Promise.all([
    buildOccupancy(supabase, windowDays),
    buildRevenue(supabase, windowDays),
    buildGuest(supabase, windowDays),
    buildSeasonal(supabase),
    buildMemory(supabase),
  ]);
  const partial = { occupancy, revenue, guest, seasonal, memory };
  return { generated_at: new Date().toISOString(), ...partial, narrative: narrate(partial) };
}
