/* eslint-disable @typescript-eslint/no-explicit-any -- ticket rows are untyped at this boundary, matching kitchen.server.ts. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
import { cn } from "@/lib/utils";
import { listRestaurantKitchenTicketsFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import { LexiBiteLoading } from "./LexiBiteLoading";

type Filter = "all" | "queued" | "preparing" | "ready";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "queued", label: "Pending" },
  { id: "preparing", label: "In Progress" },
  { id: "ready", label: "Ready" },
];

function statusTone(status: string): StatusTone {
  switch (status) {
    case "ready":
      return "success";
    case "preparing":
      return "warning";
    default:
      return "info"; // queued
  }
}

function elapsedLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Screen 7 — the kitchen/orders queue. Reads the exact same
 * listRestaurantKitchenTicketsFn the Kitchen board is built on — no second
 * ticket state model.
 */
export function MobileKitchenView({ tenantId }: { tenantId: string | undefined }) {
  const [filter, setFilter] = useState<Filter>("all");
  const fn = useServerFn(listRestaurantKitchenTicketsFn);

  const tickets = useQuery({
    queryKey: ["restaurant.kitchen.tickets.mobile", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId!, openOnly: true, limit: 100 } }) as any,
    enabled: Boolean(tenantId),
    refetchInterval: 10_000,
  });

  const rows = ((tickets.data as any[]) ?? []) as any[];
  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((t) => t.status === filter)),
    [rows, filter],
  );

  if (tickets.isLoading) return <LexiBiteLoading label="Loading kitchen queue…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors",
                filter === f.id ? "border-transparent text-white" : "border-border bg-card text-foreground",
              )}
              style={filter === f.id ? { background: "var(--lb-green)" } : undefined}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {filtered.length === 0 ? (
          <EmptyState title="No tickets" description="Nothing is queued for production right now." />
        ) : (
          <div className="space-y-2.5">
            {filtered.map((t: any) => (
              <div
                key={t.id}
                className={cn(
                  "rounded-xl border bg-card p-3.5",
                  t.breaching && "border-destructive/60 bg-destructive/5",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold">#{t.ticket_number}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.table_code ? `Table ${t.table_code}` : (t.order_number ?? "Walk-in")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={cn("text-xs font-semibold tabular-nums", t.breaching && "text-destructive")}>
                      {elapsedLabel(t.elapsed_seconds ?? 0)}
                    </p>
                    {t.breaching && <p className="text-[10px] font-semibold text-destructive">DELAYED</p>}
                  </div>
                </div>
                <ul className="mt-2 space-y-0.5 text-sm">
                  {(t.items ?? []).map((i: any) => (
                    <li key={i.id} className="text-foreground/90">
                      {Number(i.quantity)} {i.description}
                    </li>
                  ))}
                </ul>
                <div className="mt-2.5">
                  <StatusChip tone={statusTone(t.status)}>{t.status}</StatusChip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
