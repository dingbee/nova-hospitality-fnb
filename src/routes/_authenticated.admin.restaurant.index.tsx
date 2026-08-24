/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlarmClock,
  Bell,
  Boxes,
  BookOpen,
  Calculator,
  ChefHat,
  CircleDollarSign,
  Receipt,
  ShoppingCart,
  Store,
  Truck,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { getRestaurantContextFn } from "@/modules/restaurant/intelligence/context.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import { RestaurantQuickActions } from "@/modules/restaurant/ui/RestaurantQuickActions";
import { posBoardFn } from "@/modules/restaurant/sales/pos.functions";
import { listRestaurantKitchenTicketsFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import { acknowledgeServiceRequestFn } from "@/modules/restaurant/service-requests/service-requests.functions";
import { presentRestaurantBillFn } from "@/modules/restaurant/sales/bill.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/")({
  head: () => ({
    meta: [
      { title: "Restaurant & Bar OS Overview — NOVA Hospitality F&B" },
      {
        name: "description",
        content:
          "Today's live service, what needs attention, and outlet/catalogue health for the active restaurant tenant.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantOverview,
});

/** "3m ago" / "1h ago" — no library dependency for a single small formatter. */
function minutesAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

type AttentionItem = {
  key: string;
  tone: "danger" | "warn" | "info";
  icon: typeof Bell;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void; pending?: boolean };
  linkTo?: string;
  linkSearch?: Record<string, unknown>;
};

function RestaurantOverview() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = (ws.data?.roles ?? []) as readonly string[];
  const platformAdmin = ws.data?.platformAdmin ?? false;
  const canServiceFloor = hasRestaurantCapability(roles, "sales.manage", platformAdmin);
  const qc = useQueryClient();

  const contextFn = useServerFn(getRestaurantContextFn);
  const ctx = useQuery({
    queryKey: ["restaurant.context", tenantId],
    queryFn: () => contextFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  // Reuses the exact same board POS already polls every 20s — no second
  // data source for "what's happening on the floor right now".
  const boardFn = useServerFn(posBoardFn);
  const board = useQuery({
    queryKey: ["restaurant.pos.board", tenantId],
    queryFn: () => boardFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    refetchInterval: 20_000,
  });

  // Same ticket read Kitchen itself polls every 15s.
  const ticketsFn = useServerFn(listRestaurantKitchenTicketsFn);
  const tickets = useQuery({
    queryKey: ["restaurant.tickets", tenantId],
    queryFn: () => ticketsFn({ data: { tenantId: tenantId!, openOnly: true, limit: 200 } }),
    enabled: Boolean(tenantId),
    refetchInterval: 15_000,
  });

  const acknowledgeFn = useServerFn(acknowledgeServiceRequestFn);
  const acknowledge = useAdminMutation({
    mutationFn: (requestId: string) => acknowledgeFn({ data: { tenantId: tenantId!, requestId } }),
    successMessage: "Guest request acknowledged",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.pos.board"] }),
  });

  const presentBillFn = useServerFn(presentRestaurantBillFn);
  const presentBill = useAdminMutation({
    mutationFn: (orderId: string) => presentBillFn({ data: { tenantId: tenantId!, orderId } }),
    successMessage: "Bill presented",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.pos.board"] }),
  });

  if (ws.isLoading)
    return <div className="p-6 text-sm text-muted-foreground">Loading workspace…</div>;

  if (!ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of any Restaurant & Bar OS tenant yet."
      />
    );
  }

  const d = ctx.data;
  const b = board.data as any;
  const currency = ws.data?.properties[0]?.currency ?? "TZS";
  const money = (v?: number) => (v == null ? "—" : `${currency} ${v.toLocaleString()}`);

  const ticketRows = (tickets.data ?? []) as any[];
  const inProduction = ticketRows.filter((t) => ["queued", "preparing"].includes(t.status)).length;
  const readyToServe = ticketRows.filter((t) => t.status === "ready").length;
  const delayedTickets = ticketRows.filter((t) => t.breaching || t.is_delayed);

  const tableByOrderId = new Map<string, any>((b?.tables ?? []).map((t: any) => [t.order?.id, t]));
  const billsAwaitingPresentation = ((b?.openOrders ?? []) as any[]).filter(
    (o) => o.bill_requested_at && !o.bill_presented_at,
  );

  const attention: AttentionItem[] = [
    ...((b?.serviceRequests ?? []) as any[]).map((r: any): AttentionItem => {
      const table = (b?.tables ?? []).find((t: any) => t.id === r.tableId);
      return {
        key: `staff:${r.id}`,
        tone: "danger",
        icon: Bell,
        title: `Table ${table?.code ?? "?"} needs staff`,
        detail: `Requested ${minutesAgo(r.requestedAt)}`,
        action: canServiceFloor
          ? {
              label: "Acknowledge",
              onClick: () => acknowledge.mutate(r.id),
              pending: acknowledge.isPending,
            }
          : undefined,
      };
    }),
    ...billsAwaitingPresentation.map((o: any): AttentionItem => {
      const table = tableByOrderId.get(o.id);
      return {
        key: `bill:${o.id}`,
        tone: "warn",
        icon: Receipt,
        title: `Table ${table?.code ?? o.order_number} asked for the bill`,
        detail: `Requested ${minutesAgo(o.bill_requested_at)} · ${money(Number(o.total ?? 0))}`,
        action: canServiceFloor
          ? {
              label: "Present bill",
              onClick: () => presentBill.mutate(o.id),
              pending: presentBill.isPending,
            }
          : undefined,
      };
    }),
    ...delayedTickets.map((t: any): AttentionItem => ({
      key: `ticket:${t.id}`,
      tone: "warn",
      icon: AlarmClock,
      title: `Ticket ${t.ticket_number} is running late`,
      detail: `${Math.round((t.elapsed_seconds ?? 0) / 60)}m in, target ${t.target_minutes}m`,
      linkTo: "/admin/restaurant/kitchen",
    })),
    ...((d?.inventory.low ?? 0) > 0
      ? [
          {
            key: "inventory-low",
            tone: "warn" as const,
            icon: Boxes,
            title: `${d!.inventory.low} item(s) at or below reorder point`,
            detail: "Inventory centre",
            linkTo: "/admin/restaurant/inventory-control",
            linkSearch: { tab: "positions" },
          },
        ]
      : []),
    ...((d?.purchasing.open ?? 0) > 0
      ? [
          {
            key: "purchasing-open",
            tone: "info" as const,
            icon: ShoppingCart,
            title: `${d!.purchasing.open} open purchase order(s) to follow up`,
            detail: money(d?.purchasing.openValue),
            linkTo: "/admin/restaurant/procurement",
            linkSearch: { tab: "requests" },
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={ws.data.tenant.name}
        description={`Restaurant & Bar OS · ${ws.data.subscription?.plan ?? "no plan"} · ${ws.data.locations.length} outlets`}
      />

      <RestaurantQuickActions />

      {/*
        What is happening right now — the exact same posBoard() POS itself
        polls every 20s, and the exact same open-ticket read Kitchen polls
        every 15s. No second live-data source: this is a different view
        over the same facts, not a new one.
      */}
      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Today's service
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Open tables / bills"
            value={board.isPending ? "—" : String(b?.stats.openBills ?? 0)}
            icon={Receipt}
          />
          <StatCard
            label="Covers today"
            value={board.isPending ? "—" : String(b?.stats.coversToday ?? 0)}
            icon={Users}
          />
          <StatCard
            label="Revenue today"
            value={board.isPending ? "—" : money(b?.stats.revenueToday)}
            icon={CircleDollarSign}
            tone="gold"
          />
          <StatCard
            label="Kitchen & bar tickets"
            value={tickets.isPending ? "—" : `${inProduction} in prep · ${readyToServe} ready`}
            icon={ChefHat}
            tone={delayedTickets.length > 0 ? "warn" : "green"}
            hint={delayedTickets.length > 0 ? `${delayedTickets.length} running late` : undefined}
          />
        </div>
      </div>

      <SectionCard
        title="Needs attention"
        description="Guest requests, tickets and stock signals, most urgent first."
      >
        {attention.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing needs attention right now.
          </p>
        ) : (
          <ul className="space-y-2">
            {attention.map((item) => (
              <li
                key={item.key}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
                  item.tone === "danger"
                    ? "border-[color:var(--os-danger)]/40 bg-[color:var(--os-danger-soft)]"
                    : item.tone === "warn"
                      ? "border-[color:var(--os-warn)]/40 bg-[color:var(--os-warn-soft)]"
                      : "border-[color:var(--os-info)]/40 bg-[color:var(--os-info-soft)]"
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                </span>
                {item.action ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={item.action.pending}
                    onClick={item.action.onClick}
                    className="shrink-0"
                  >
                    {item.action.label}
                  </Button>
                ) : item.linkTo ? (
                  <Link
                    to={item.linkTo}
                    search={item.linkSearch as never}
                    className="shrink-0 text-sm font-medium text-primary hover:underline"
                  >
                    View
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/*
        Structural/setup health — outlets, catalogue, stock, suppliers.
        Kept below the live section: it changes far less often and isn't
        what "needs attention right now" answers.
      */}
      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Menu &amp; catalogue
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Outlets" value={String(d?.locations ?? "—")} icon={Store} />
          <StatCard
            label="Menus published"
            value={d ? `${d.menus.published}/${d.menus.total}` : "—"}
            icon={BookOpen}
          />
          <StatCard
            label="Menu items available"
            value={d ? `${d.menuItems.available}/${d.menuItems.total}` : "—"}
            icon={BookOpen}
          />
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Inventory &amp; procurement
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard
            label="Stock items"
            value={String(d?.inventory.total ?? "—")}
            icon={Boxes}
            hint={d ? `${d.inventory.low} at or below reorder point` : undefined}
            tone={(d?.inventory.low ?? 0) > 0 ? "warn" : "green"}
          />
          <StatCard label="Stock value" value={money(d?.inventory.stockValue)} icon={Boxes} />
          <StatCard
            label="Suppliers"
            value={d ? `${d.suppliers.active}/${d.suppliers.total}` : "—"}
            icon={Truck}
          />
          <StatCard
            label="Open purchase orders"
            value={String(d?.purchasing.open ?? "—")}
            icon={ShoppingCart}
            hint={d ? money(d.purchasing.openValue) : undefined}
          />
          <StatCard
            label="Average food cost"
            value={
              d?.costing.averageFoodCostPercent != null
                ? `${d.costing.averageFoodCostPercent}%`
                : "—"
            }
            icon={Calculator}
            hint={d ? `${d.costing.costedItems} costed items` : undefined}
          />
        </div>
      </div>

      <SectionCard title="Outlets" description="Service locations in this tenant.">
        {ws.data.locations.length === 0 ? (
          <EmptyState
            title="No outlets yet"
            description="Outlets are the service locations that own menus, orders and stock. Add your first restaurant, bar or kitchen in Settings to start operating."
          />
        ) : (
          <ul className="divide-y text-sm">
            {ws.data.locations.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate">{l.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs uppercase text-muted-foreground">{l.location_type}</span>
                  <StatusChip tone={l.status === "active" ? "success" : "neutral"}>
                    {l.status}
                  </StatusChip>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
