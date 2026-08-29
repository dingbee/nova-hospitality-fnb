/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlarmClock, ChefHat, Timer } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  advanceRestaurantTicketFn,
  listRestaurantKitchenTicketsFn,
  listRestaurantStationsFn,
  restaurantStationPerformanceFn,
} from "@/modules/restaurant/kitchen/kitchen.functions";
import { kitchenStationIds } from "@/modules/restaurant/sales/stationRouting";
import { BAR_STATION_TYPES } from "@/modules/restaurant/bar/contracts";

export const Route = createFileRoute("/_authenticated/admin/restaurant/kitchen")({
  head: () => ({
    meta: [
      { title: "Kitchen — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Live station tickets, preparation states, prep times and service delays.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: KitchenPage,
});

const NEXT: Record<string, "preparing" | "ready" | "served"> = {
  queued: "preparing",
  preparing: "ready",
  ready: "served",
};

function mmss(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.abs(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Presentation-only status → urgency tone, matching the idiom already used on the Bar prep board. */
function ticketStatusTone(status: string): "info" | "warning" | "success" | "neutral" {
  switch (status) {
    case "preparing":
      return "warning";
    case "ready":
      return "success";
    case "served":
      return "neutral";
    default:
      return "info"; // "queued"
  }
}

function KitchenPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();

  const ticketsFn = useServerFn(listRestaurantKitchenTicketsFn);
  const stationsFn = useServerFn(listRestaurantStationsFn);
  const perfFn = useServerFn(restaurantStationPerformanceFn);
  const advanceFn = useServerFn(advanceRestaurantTicketFn);

  const stations = useQuery({
    queryKey: ["restaurant.stations", tenantId],
    queryFn: () => stationsFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
  });
  // The Kitchen board's own scope — every non-bar station — the same
  // "bar or not" classification the routing decision itself uses, not a
  // hardcoded list. A bar-only order's ticket carries the bar's own
  // station_id (confirmed against live data: one ticket, one station, no
  // duplication); it was showing here anyway because this read carried no
  // station filter at all, unlike the Bar board's own scoped read.
  const kitchenStationIdList = kitchenStationIds((stations.data ?? []) as any[], BAR_STATION_TYPES);

  const tickets = useQuery({
    queryKey: ["restaurant.tickets", tenantId, kitchenStationIdList],
    queryFn: () =>
      ticketsFn({
        data: { tenantId: tenantId!, stationIds: kitchenStationIdList, openOnly: true, limit: 100 },
      }),
    enabled: Boolean(tenantId) && stations.data !== undefined,
    refetchInterval: 15_000,
  });
  const perf = useQuery({
    queryKey: ["restaurant.stationPerf", tenantId],
    queryFn: () => perfFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  const advance = useAdminMutation({
    mutationFn: (vars: { ticketId: string; status: "preparing" | "ready" | "served" }) =>
      advanceFn({ data: { tenantId: tenantId!, ticketId: vars.ticketId, status: vars.status } }),
    successMessage: "Ticket updated",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.tickets"] });
      void qc.invalidateQueries({ queryKey: ["restaurant.stationPerf"] });
    },
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  const rows = tickets.data ?? [];
  const breaching = rows.filter((t: any) => t.breaching);
  // Station names, cross-referenced from the performance query already in
  // memory — no new fetch, purely a lookup so a ticket can say "Grill" or
  // "Fryer" instead of leaving the operator to infer it from ticket content.
  const stationNameById = new Map((perf.data ?? []).map((s: any) => [s.station_id, s.name]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Kitchen"
        description="Station queues, preparation states and measured service delays."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Open tickets" value={String(rows.length)} icon={ChefHat} />
        <StatCard
          label="Breaching target"
          value={String(breaching.length)}
          icon={AlarmClock}
          tone={breaching.length > 0 ? "danger" : "green"}
        />
        <StatCard
          label="Avg prep (7 days)"
          value={
            (perf.data ?? []).length > 0
              ? `${(
                  (perf.data ?? []).reduce((s: any, p: any) => s + p.avg_prep_minutes, 0) /
                  (perf.data ?? []).length
                ).toFixed(1)} min`
              : "—"
          }
          icon={Timer}
        />
      </div>

      <SectionCard title="Live tickets" description="Oldest and highest priority first.">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing on the pass"
            description="Fire an order from the Orders screen to create tickets."
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((t: any) => (
              <li
                key={t.id}
                className={`rounded-xl border p-3 ${t.breaching ? "border-destructive/40 bg-destructive/5" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t.ticket_number}</span>
                  <StatusChip tone={ticketStatusTone(t.status)}>{t.status}</StatusChip>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.table_code ? `Table ${t.table_code}` : (t.order_number ?? "Walk-in / bar tab")}{" "}
                  · {stationNameById.get(t.station_id) ?? "Station"} · fired{" "}
                  {new Date(t.queued_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <p
                  className={`mt-1.5 text-sm font-semibold tabular-nums ${t.breaching ? "text-destructive" : "text-foreground"}`}
                >
                  {mmss(t.elapsed_seconds)}{" "}
                  <span className="font-normal text-muted-foreground">
                    of {t.target_minutes}m target
                  </span>
                </p>
                <ul className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                  {t.items.length === 0 && <li>No items</li>}
                  {t.items.map((i: any) => (
                    <li key={i.id}>
                      {Number(i.quantity)}× {i.description}
                      {i.notes ? <span className="italic"> — {i.notes}</span> : null}
                    </li>
                  ))}
                </ul>
                {NEXT[t.status] && (
                  <Button
                    className="mt-2 min-h-11 w-full"
                    variant={t.status === "ready" ? "outline" : "secondary"}
                    disabled={advance.isPending}
                    onClick={() => advance.mutate({ ticketId: t.id, status: NEXT[t.status]! })}
                  >
                    Mark {NEXT[t.status]}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Station performance"
        description="Rolling 7-day on-time service by station."
      >
        {(perf.data ?? []).length === 0 ? (
          <EmptyState
            title="No stations"
            description="Create stations to route tickets and measure prep time."
          />
        ) : (
          <ul className="divide-y text-sm">
            {(perf.data ?? []).map((s: any) => (
              <li key={s.station_id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate">{s.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {s.tickets} tickets · avg {s.avg_prep_minutes}m vs {s.target_minutes}m
                  {s.on_time_percent != null ? (
                    <StatusChip
                      tone={
                        s.on_time_percent >= 90
                          ? "success"
                          : s.on_time_percent >= 70
                            ? "warning"
                            : "danger"
                      }
                    >
                      {s.on_time_percent}% on time
                    </StatusChip>
                  ) : (
                    "no data"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
