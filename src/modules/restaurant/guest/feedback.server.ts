/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Staff-facing read over restaurant_guest_feedback (migration
 * 0007_guest_feedback.sql). The guest write path (selffeedback.server.ts)
 * has existed since Phase 7; this is the first staff read — management has
 * had no visibility into guest ratings/comments until now. RLS already
 * permits any tenant member to select this table (`restaurant_can_read`),
 * so assertTenantRead is the correct, matching gate rather than a
 * capability restricted to a subset of roles.
 */
import { assertTenantRead } from "../core/access.server";
import { percentChange, round } from "../intelligence/analysis";

type Sb = any;
const DAY = 864e5;

export interface GuestFeedbackRow {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  orderNumber: string | null;
  tableCode: string | null;
}

export interface GuestFeedbackSummary {
  windowDays: number;
  count: number;
  averageRating: number | null;
  previousAverageRating: number | null;
  trendPercent: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  lowRatingCount: number;
  recent: GuestFeedbackRow[];
}

export async function getGuestFeedbackSummary(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<GuestFeedbackSummary> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const prevStart = new Date(now - 2 * windowDays * DAY).toISOString();

  const { data: rows } = await sb
    .from("restaurant_guest_feedback")
    .select("id, rating, comment, created_at, order_id, table_id")
    .eq("tenant_id", tenantId)
    .gte("created_at", prevStart)
    .order("created_at", { ascending: false })
    .limit(1000);

  const feedback = (rows ?? []) as any[];
  const current = feedback.filter((f) => f.created_at >= start);
  const previous = feedback.filter((f) => f.created_at < start);

  const avg = (v: any[]): number | null =>
    v.length === 0 ? null : round(v.reduce((s, f) => s + Number(f.rating), 0) / v.length, 2);
  const averageRating = avg(current);
  const previousAverageRating = avg(previous);
  const trendPercent =
    averageRating != null && previousAverageRating != null
      ? percentChange(averageRating, previousAverageRating)
      : null;

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const f of current) {
    const r = Number(f.rating) as 1 | 2 | 3 | 4 | 5;
    if (r in distribution) distribution[r] += 1;
  }
  const lowRatingCount = distribution[1] + distribution[2];

  const recentSource = current.slice(0, 50);
  const orderIds = [...new Set(recentSource.map((f) => f.order_id).filter(Boolean))];
  const tableIds = [...new Set(recentSource.map((f) => f.table_id).filter(Boolean))];

  const [{ data: orders }, { data: tables }] = await Promise.all([
    orderIds.length > 0
      ? sb
          .from("restaurant_orders")
          .select("id, order_number")
          .eq("tenant_id", tenantId)
          .in("id", orderIds)
      : Promise.resolve({ data: [] }),
    tableIds.length > 0
      ? sb.from("restaurant_tables").select("id, code").eq("tenant_id", tenantId).in("id", tableIds)
      : Promise.resolve({ data: [] }),
  ]);
  const orderNumberById = new Map(((orders ?? []) as any[]).map((o) => [o.id, o.order_number]));
  const tableCodeById = new Map(((tables ?? []) as any[]).map((t) => [t.id, t.code]));

  const recent: GuestFeedbackRow[] = recentSource.map((f) => ({
    id: f.id,
    rating: Number(f.rating),
    comment: f.comment,
    createdAt: f.created_at,
    orderNumber: f.order_id ? (orderNumberById.get(f.order_id) ?? null) : null,
    tableCode: f.table_id ? (tableCodeById.get(f.table_id) ?? null) : null,
  }));

  return {
    windowDays,
    count: current.length,
    averageRating,
    previousAverageRating,
    trendPercent,
    distribution,
    lowRatingCount,
    recent,
  };
}
