/* eslint-disable @typescript-eslint/no-explicit-any -- receipt rows are untyped at this boundary, matching ReceiptCentre. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/os/EmptyState";
import { listRestaurantReceiptsFn } from "../../bill.functions";
import { money } from "../pos-types";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";
import { LexiBiteLoading } from "./LexiBiteLoading";

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);

/** Screen 6 — same receipt query ReceiptCentre uses, a mobile-native card list. */
export function MobileReceiptsView({
  data,
  onOpenReceipt,
}: {
  data: LexiBiteMobilePosData;
  onOpenReceipt: (orderId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const listFn = useServerFn(listRestaurantReceiptsFn);
  const tenantId = data.tenantId ?? "";

  const receipts = useQuery({
    queryKey: ["restaurant.receipts", tenantId, query, weekAgo(), today()],
    enabled: Boolean(tenantId),
    queryFn: () =>
      listFn({ data: { tenantId, query, from: weekAgo(), to: today(), limit: 100 } }) as any,
  });

  const rows = ((receipts.data as any[]) ?? []) as any[];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search receipt number…"
            className="h-12 rounded-full pl-9 text-[15px]"
            enterKeyHint="search"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Last 7 days · {rows.length} receipts</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {receipts.isLoading ? (
          <LexiBiteLoading label="Loading receipts…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No receipts" description="No receipts were issued in this period." />
        ) : (
          <div className="space-y-2.5">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenReceipt(r.orderId)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3.5 text-left active:bg-muted"
              >
                <div className="min-w-0">
                  <p className="font-semibold">{r.number}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Order {r.orderNumber ?? "—"} · {r.guestName ?? "Walk-in"} ·{" "}
                    {String(r.issuedAt ?? "").replace("T", " ").slice(0, 16)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.deliveredAt ? `Delivered · ${r.deliveryChannel}` : "Not delivered"}
                    {r.reprints > 0 ? ` · ${r.reprints} reprint${r.reprints === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-base font-bold tabular-nums">
                  {money(Number(r.total ?? 0), r.currency ?? data.currency)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
