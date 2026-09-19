/* eslint-disable @typescript-eslint/no-explicit-any -- board rows are untyped at this boundary, matching PosWorkspace. */
import { useMemo, useState } from "react";
import { Bell, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/os/EmptyState";
import { cn } from "@/lib/utils";
import { TABLE_TONE_CLASS, TABLE_TONE_LABEL } from "../lifecycle";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";
import { LexiBiteLoading } from "./LexiBiteLoading";

function elapsedLabel(openedAt: string | null | undefined): string | null {
  if (!openedAt) return null;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(openedAt).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The mobile POS home screen — a fast-to-scan grid of tables/tabs. Colour
 * follows the bill's lifecycle (tableToneFor → the same TABLE_TONE_CLASS the
 * desktop floor uses), never a second state model.
 */
export function MobileTablesView({
  data,
  onOpenOrder,
  onStartOrder,
}: {
  data: LexiBiteMobilePosData;
  onOpenOrder: (orderId: string) => void;
  onStartOrder: (tableId: string, guestCount: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState<string | null>(null);

  const zones = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.tables) if (t.zone) set.add(String(t.zone));
    return [...set].sort();
  }, [data.tables]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.tables.filter((t: any) => {
      if (zone && String(t.zone ?? "") !== zone) return false;
      if (!q) return true;
      const haystack = [t.code, t.name, t.order?.order_number, t.order?.guest_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [data.tables, query, zone]);

  if (data.board.isLoading) return <LexiBiteLoading label="Loading tables…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2.5 px-4 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search table, guest or order…"
            className="h-12 rounded-full pl-9 text-[15px]"
            enterKeyHint="search"
          />
        </div>
        {zones.length > 0 && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            <FilterChip label="All" active={zone === null} onClick={() => setZone(null)} />
            {zones.map((z) => (
              <FilterChip key={z} label={z} active={zone === z} onClick={() => setZone(z)} />
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {filtered.length === 0 ? (
          <EmptyState
            title={query || zone ? "No matches" : "No tables configured"}
            description={
              query || zone ? "Try a different search or filter." : "Configure tables to seat guests."
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((t: any) => {
              const tone = data.tableToneFor(t);
              const elapsed = elapsedLabel(t.order?.opened_at);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    t.order ? onOpenOrder(t.order.id) : onStartOrder(t.id, t.seats ?? 2)
                  }
                  disabled={data.mutations.openBill.isPending}
                  className={cn(
                    "relative min-h-[104px] rounded-2xl border-2 p-3.5 text-left shadow-sm active:scale-[0.98] disabled:opacity-60",
                    TABLE_TONE_CLASS[tone],
                  )}
                >
                  {t.serviceRequest && (
                    <span
                      className={cn(
                        "absolute -right-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full border-2 bg-card",
                        t.serviceRequest.status === "acknowledged"
                          ? "border-amber-500 text-amber-600"
                          : "border-destructive text-destructive",
                      )}
                      aria-label="Guest needs staff"
                    >
                      <Bell className="size-3.5" />
                    </span>
                  )}
                  <span className="block text-lg font-bold leading-tight">{t.code}</span>
                  <span className="mt-1.5 block text-sm font-medium text-foreground/80">
                    {t.order ? `${t.order.guest_count ?? "?"} pax` : `${t.seats} seats`}
                  </span>
                  {elapsed && <span className="block text-xs text-foreground/60">{elapsed}</span>}
                  <span className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
                    {TABLE_TONE_LABEL[tone]}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors",
        active ? "border-transparent text-white" : "border-border bg-card text-foreground",
      )}
      style={active ? { background: "var(--lb-green)" } : undefined}
    >
      {label}
    </button>
  );
}
