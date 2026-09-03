/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlarmClock, ChefHat, Timer } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { IntelligenceModule } from "@/components/os/IntelligenceModule";
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

/**
 * One dense ticket card. Field order follows the pass, not the schema:
 * KOT#, table/service context, elapsed time, then item quantity/name/
 * modifiers/notes, station, and the single primary action last.
 */
function KitchenTicketCard({
  ticket,
  stationName,
  advancing,
  onAdvance,
}: {
  ticket: any;
  stationName: string;
  advancing: boolean;
  onAdvance: (status: "preparing" | "ready" | "served") => void;
}) {
  const next = NEXT[ticket.status];
  return (
    <li
      className={`flex flex-col gap-2 rounded-xl border p-3 ${
        ticket.breaching ? "border-destructive/50 bg-destructive/5" : "bg-card"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-base font-semibold tabular-nums">
          {ticket.ticket_number}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {ticket.breaching && <StatusChip tone="danger">Attention</StatusChip>}
          <StatusChip tone={ticketStatusTone(ticket.status)}>{ticket.status}</StatusChip>
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate font-medium text-foreground">
          {ticket.table_code
            ? `Table ${ticket.table_code}`
            : (ticket.order_number ?? "Walk-in / bar tab")}
        </span>
        <span className="shrink-0">{stationName}</span>
      </div>

      <p
        className={`text-lg font-semibold leading-none tabular-nums ${
          ticket.breaching ? "text-destructive" : "text-foreground"
        }`}
      >
        {mmss(ticket.elapsed_seconds)}{" "}
        <span className="text-xs font-normal text-muted-foreground">
          of {ticket.target_minutes}m target
        </span>
      </p>

      <ul className="space-y-1 text-sm">
        {ticket.items.length === 0 && <li className="text-muted-foreground">No items</li>}
        {ticket.items.map((i: any) => (
          <li key={i.id}>
            <span className="font-semibold tabular-nums">{Number(i.quantity)}×</span>{" "}
            {i.description}
            {(i.modifiers ?? []).length > 0 && (
              <span className="block text-xs text-muted-foreground">
                {i.modifiers.map((m: any) => m.name).join(", ")}
              </span>
            )}
            {i.notes && (
              <span className="block text-xs italic text-muted-foreground">— {i.notes}</span>
            )}
          </li>
        ))}
      </ul>

      {next && (
        <Button
          className="mt-1 min-h-11 w-full"
          variant={ticket.status === "ready" ? "outline" : "secondary"}
          disabled={advancing}
          onClick={() => onAdvance(next)}
        >
          Mark {next}
        </Button>
      )}
    </li>
  );
}

function KitchenPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();
  const [stationFilter, setStationFilter] = useState<string | null>(null);

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
  const kitchenStations = ((stations.data ?? []) as any[]).filter((s) =>
    kitchenStationIdList.includes(s.id),
  );
  const visibleRows = stationFilter
    ? rows.filter((t: any) => t.station_id === stationFilter)
    : rows;
  const avgPrepLabel =
    (perf.data ?? []).length > 0
      ? `${(
          (perf.data ?? []).reduce((s: any, p: any) => s + p.avg_prep_minutes, 0) /
          (perf.data ?? []).length
        ).toFixed(1)} min`
      : "—";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Kitchen"
        description="Station queues, preparation states and measured service delays."
      />

      {/* Compact — this is a working pass display, not a KPI dashboard. */}
      <div className="os-card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <span className="flex items-center gap-2">
          <ChefHat className="size-4 text-[color:var(--os-ink-3)]" aria-hidden />
          <span className="text-sm font-semibold tabular-nums">{rows.length}</span>
          <span className="text-xs text-muted-foreground">open tickets</span>
        </span>
        <span className="flex items-center gap-2">
          <AlarmClock
            className={`size-4 ${breaching.length > 0 ? "text-destructive" : "text-[color:var(--os-ink-3)]"}`}
            aria-hidden
          />
          <span
            className={`text-sm font-semibold tabular-nums ${breaching.length > 0 ? "text-destructive" : ""}`}
          >
            {breaching.length}
          </span>
          <span className="text-xs text-muted-foreground">breaching target</span>
        </span>
        <span className="flex items-center gap-2">
          <Timer className="size-4 text-[color:var(--os-ink-3)]" aria-hidden />
          <span className="text-sm font-semibold tabular-nums">{avgPrepLabel}</span>
          <span className="text-xs text-muted-foreground">avg prep (7 days)</span>
        </span>
      </div>

      {kitchenStations.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by station">
          <Button
            variant={stationFilter ? "outline" : "default"}
            size="sm"
            className="min-h-9 rounded-full"
            onClick={() => setStationFilter(null)}
          >
            All stations
          </Button>
          {kitchenStations.map((s: any) => (
            <Button
              key={s.id}
              variant={stationFilter === s.id ? "default" : "outline"}
              size="sm"
              className="min-h-9 rounded-full"
              onClick={() => setStationFilter(s.id)}
            >
              {s.name}
            </Button>
          ))}
        </div>
      )}

      <SectionCard title="Live tickets" description="Oldest and highest priority first.">
        {visibleRows.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "Nothing on the pass" : "No tickets at this station"}
            description={
              rows.length === 0
                ? "Fire an order from the Orders screen to create tickets."
                : "Try a different station filter."
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visibleRows.map((t: any) => (
              <KitchenTicketCard
                key={t.id}
                ticket={t}
                stationName={stationNameById.get(t.station_id) ?? "Station"}
                advancing={advance.isPending}
                onAdvance={(status) => advance.mutate({ ticketId: t.id, status })}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Analytics belong on a secondary surface, collapsed by default, so
          they never compete with the live pass for the operator's attention. */}
      <IntelligenceModule
        title="Kitchen Performance"
        headline={
          (perf.data ?? []).length > 0
            ? `${(perf.data ?? []).length} station${(perf.data ?? []).length === 1 ? "" : "s"} tracked · ${avgPrepLabel} avg prep`
            : "No stations tracked yet"
        }
        meta="Rolling 7-day on-time service by station"
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
      </IntelligenceModule>
    </div>
  );
}
