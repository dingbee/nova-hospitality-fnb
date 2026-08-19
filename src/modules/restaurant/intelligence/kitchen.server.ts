/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3.3 — Kitchen Performance Intelligence.
 * Station prep times against targets, dinner-peak pressure, and week-on-week trend.
 */
import { assertTenantRead } from "../core/access.server";
import { percentChange, round } from "./analysis";
import type { KitchenIntelligence, RestaurantInsight, StationPerformance } from "./types";

type Sb = any;
const DAY = 864e5;
const DINNER_FROM = 17;
const DINNER_TO = 22;

const avg = (v: number[]): number | null => (v.length === 0 ? null : round(v.reduce((s, n) => s + n, 0) / v.length, 1));

export async function getKitchenIntelligence(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<KitchenIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const prevStart = new Date(now - 2 * windowDays * DAY).toISOString();

  const [ticketsRes, stationsRes] = await Promise.all([
    sb
      .from("restaurant_kitchen_tickets")
      .select("id, station_id, status, queued_at, prep_seconds, is_delayed, target_minutes")
      .eq("tenant_id", tenantId)
      .gte("queued_at", prevStart),
    sb.from("restaurant_stations").select("id, name, target_prep_minutes, active").eq("tenant_id", tenantId),
  ]);

  const tickets = ((ticketsRes.data ?? []) as any[]).filter((t) => Number(t.prep_seconds ?? 0) > 0);
  const current = tickets.filter((t) => t.queued_at >= start);
  const previous = tickets.filter((t) => t.queued_at < start);

  const mins = (t: any) => round(Number(t.prep_seconds) / 60, 1);

  const stations: StationPerformance[] = ((stationsRes.data ?? []) as any[]).map((s) => {
    const own = current.filter((t) => t.station_id === s.id);
    const prepValues = own.map(mins);
    const dinner = own.filter((t) => {
      const h = new Date(t.queued_at).getHours();
      return h >= DINNER_FROM && h <= DINNER_TO;
    });
    const target = s.target_prep_minutes == null ? null : Number(s.target_prep_minutes);
    const average = avg(prepValues);
    const delayed = own.filter((t) => t.is_delayed).length;
    return {
      stationId: s.id,
      name: s.name,
      targetMinutes: target,
      tickets: own.length,
      averagePrepMinutes: average,
      peakPrepMinutes: prepValues.length > 0 ? Math.max(...prepValues) : null,
      delayedTickets: delayed,
      delayedPercent: own.length > 0 ? round((delayed / own.length) * 100, 1) : null,
      overTarget: target != null && average != null && average > target,
      dinnerPeakMinutes: avg(dinner.map(mins)),
    };
  });
  stations.sort((a, b) => (b.averagePrepMinutes ?? 0) - (a.averagePrepMinutes ?? 0));

  const averagePrep = avg(current.map(mins));
  const previousAverage = avg(previous.map(mins));
  const trend = averagePrep != null && previousAverage != null ? percentChange(averagePrep, previousAverage) : null;

  const insights: RestaurantInsight[] = [];
  for (const s of stations) {
    if (s.targetMinutes != null && s.dinnerPeakMinutes != null && s.dinnerPeakMinutes > s.targetMinutes) {
      insights.push({
        key: `kitchen.peak.${s.stationId}`,
        severity: s.dinnerPeakMinutes > s.targetMinutes * 1.5 ? "high" : "medium",
        title: `${s.name} exceeds acceptable preparation time during dinner peak`,
        detail: `${s.dinnerPeakMinutes} min average between ${DINNER_FROM}:00 and ${DINNER_TO}:00 against a ${s.targetMinutes} min target across ${s.tickets} tickets.`,
        metric: `${s.dinnerPeakMinutes} min vs ${s.targetMinutes} min`,
        recommendation: "Add prep-ahead mise en place or a second hand on this station for dinner service.",
      });
    } else if (s.overTarget) {
      insights.push({
        key: `kitchen.over_target.${s.stationId}`,
        severity: "medium",
        title: `${s.name} runs above its prep target`,
        detail: `${s.averagePrepMinutes} min average against a ${s.targetMinutes} min target.`,
        metric: `${s.delayedPercent ?? 0}% delayed`,
        recommendation: "Review the station's ticket mix and equipment bottlenecks.",
      });
    }
  }
  if (trend != null && Math.abs(trend) >= 5) {
    insights.push({
      key: "kitchen.trend",
      severity: trend < 0 ? "info" : "medium",
      title:
        trend < 0
          ? `Average ticket time improved ${Math.abs(trend)}%`
          : `Average ticket time slowed ${trend}%`,
      detail: `${averagePrep} min now versus ${previousAverage} min in the previous ${windowDays} days.`,
      metric: `${trend > 0 ? "+" : ""}${trend}%`,
      recommendation:
        trend < 0
          ? "Record what changed in the workflow so the gain is repeatable."
          : "Check staffing levels and menu complexity added during this period.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    ticketsAnalysed: current.length,
    averagePrepMinutes: averagePrep,
    previousAveragePrepMinutes: previousAverage,
    trendPercent: trend,
    stations,
    insights,
  };
}