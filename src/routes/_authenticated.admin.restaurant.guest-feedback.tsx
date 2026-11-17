/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AlertTriangle, MessageSquare, Star, Users } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { getGuestFeedbackSummaryFn } from "@/modules/restaurant/guest/feedback.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/guest-feedback")({
  head: () => ({
    meta: [
      { title: "Guest Feedback — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Post-dining ratings and comments submitted by guests through self-order.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: GuestFeedbackPage,
});

const WINDOWS = [7, 14, 30, 60] as const;

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function FeedbackRow({ row }: { row: any }) {
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <Star className="size-3.5 fill-current text-amber-500" />
          {row.rating}/5
          {row.rating <= 2 ? <StatusChip tone="danger">Needs follow-up</StatusChip> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.tableCode ? `Table ${row.tableCode}` : (row.orderNumber ?? "Order")} ·{" "}
          {fmtDate(row.createdAt)}
        </span>
      </div>
      {row.comment ? <p className="text-sm text-muted-foreground">{row.comment}</p> : null}
    </li>
  );
}

function GuestFeedbackPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const [windowDays, setWindowDays] = useState<number>(30);

  const summaryFn = useServerFn(getGuestFeedbackSummaryFn);
  const summary = useQuery({
    queryKey: ["restaurant", "guestFeedback", tenantId, windowDays],
    queryFn: () => summaryFn({ data: { tenantId: tenantId as string, windowDays } }),
    enabled: Boolean(tenantId),
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  const s = summary.data as any;
  const distribution = s?.distribution as Record<string, number> | undefined;
  const maxBucket = distribution ? Math.max(1, ...Object.values(distribution)) : 1;
  const lowRatings = ((s?.recent ?? []) as any[]).filter((r) => r.rating <= 2);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Guest Feedback"
        description="What guests said about their visit, straight from the post-dining prompt on self-order."
        actions={
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === windowDays ? "default" : "outline"}
                onClick={() => setWindowDays(w)}
              >
                {w}d
              </Button>
            ))}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Average rating"
          value={s?.averageRating != null ? `${s.averageRating}/5` : "—"}
          icon={Star}
          hint={
            s?.trendPercent != null
              ? `${s.trendPercent > 0 ? "+" : ""}${s.trendPercent}% vs prior ${windowDays}d`
              : undefined
          }
        />
        <StatCard label="Responses" value={s ? String(s.count) : "—"} icon={Users} />
        <StatCard
          label="Needs follow-up"
          value={s ? String(s.lowRatingCount) : "—"}
          icon={AlertTriangle}
          tone={s?.lowRatingCount > 0 ? "danger" : "green"}
          hint="1–2 star ratings"
        />
      </div>

      <SectionCard title="Rating distribution" description={`Last ${windowDays} days.`}>
        {!s || s.count === 0 ? (
          <EmptyState
            title="No feedback yet"
            description="Guests are prompted to rate their visit after their bill is paid on self-order."
            icon={MessageSquare}
          />
        ) : (
          <ul className="space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => {
              const n = distribution?.[star] ?? 0;
              return (
                <li key={star} className="flex items-center gap-2 text-sm">
                  <span className="w-10 shrink-0 text-muted-foreground">{star}★</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${(n / maxBucket) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">{n}</span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {lowRatings.length > 0 ? (
        <SectionCard
          title="Needs follow-up"
          description="1–2 star ratings in this window — worth a manager review or a guest callback."
        >
          <ul className="divide-y">
            {lowRatings.map((row) => (
              <FeedbackRow key={row.id} row={row} />
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Recent feedback" description="Most recent responses first.">
        {(s?.recent ?? []).length === 0 ? (
          <EmptyState
            title="Nothing to show"
            description="No feedback has been submitted in this window."
          />
        ) : (
          <ul className="divide-y">
            {(s.recent as any[]).map((row) => (
              <FeedbackRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
