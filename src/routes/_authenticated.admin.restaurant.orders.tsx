/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Receipt, CircleDollarSign, Users, ChefHat } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  createRestaurantOrderFn,
  listRestaurantOrdersFn,
  listRestaurantTablesFn,
  transitionRestaurantOrderFn,
} from "@/modules/restaurant/sales/sales.functions";
import { fireRestaurantOrderFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import { deriveLifecycle, STAGE_LABEL } from "@/modules/restaurant/sales/ui/lifecycle";

export const Route = createFileRoute("/_authenticated/admin/restaurant/orders")({
  head: () => ({
    meta: [
      { title: "Orders — Restaurant & Bar OS" },
      { name: "description", content: "Live orders, covers, payment state and service progress across outlets." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OrdersPage,
});

const OPEN_STATES = ["open", "sent", "served"];

function OrdersPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState<string | undefined>(undefined);

  const listFn = useServerFn(listRestaurantOrdersFn);
  const tablesFn = useServerFn(listRestaurantTablesFn);
  const createFn = useServerFn(createRestaurantOrderFn);
  const transitionFn = useServerFn(transitionRestaurantOrderFn);
  const fireFn = useServerFn(fireRestaurantOrderFn);

  const orders = useQuery({
    queryKey: ["restaurant.orders", tenantId, locationId],
    queryFn: () => listFn({ data: { tenantId: tenantId!, locationId, limit: 50 } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });
  const tables = useQuery({
    queryKey: ["restaurant.tables", tenantId, locationId],
    queryFn: () => tablesFn({ data: { tenantId: tenantId!, locationId } }),
    enabled: Boolean(tenantId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.orders"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.tickets"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.tables"] });
  };

  const openOrder = useAdminMutation({
    mutationFn: (vars: { tableId?: string }) =>
      createFn({
        data: {
          tenantId: tenantId!,
          locationId,
          tableId: vars.tableId,
          orderType: "dine_in",
          guestCount: 2,
          currency: ws.data?.properties[0]?.currency ?? "TZS",
          lines: [],
        },
      }),
    successMessage: "Order opened",
    onSuccess: invalidate,
  });

  const changeStatus = useAdminMutation({
    mutationFn: (vars: { orderId: string; status: "served" | "closed" | "voided" }) =>
      transitionFn({ data: { tenantId: tenantId!, orderId: vars.orderId, status: vars.status } }),
    successMessage: "Order updated",
    onSuccess: invalidate,
  });

  const fire = useAdminMutation({
    mutationFn: (vars: { orderId: string }) =>
      fireFn({ data: { tenantId: tenantId!, orderId: vars.orderId, orderItemIds: [], priority: 0 } }),
    onSuccessToast: (d) => `${(d as { fired: number }).fired} item(s) fired to the kitchen`,
    onSuccess: invalidate,
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const rows = orders.data ?? [];
  const open = rows.filter((r: any) => OPEN_STATES.includes(r.status));
  const currency = ws.data?.properties[0]?.currency ?? "TZS";
  const money = (v: unknown) => `${currency} ${Number(v ?? 0).toLocaleString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        description="Every sale that enters NOVA Hospitality F&B — covers, revenue, payment state and actual cost."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open orders" value={String(open.length)} icon={Receipt} />
        <StatCard label="Covers (open)" value={String(open.reduce((s: any, r: any) => s + Number(r.guest_count ?? 0), 0))} icon={Users} />
        <StatCard label="Open value" value={money(open.reduce((s: any, r: any) => s + Number(r.total ?? 0), 0))} icon={CircleDollarSign} tone="gold" />
        <StatCard
          label="Unpaid"
          value={String(rows.filter((r: any) => r.payment_state === "unpaid" && r.status !== "cancelled").length)}
          icon={CircleDollarSign}
          tone="warn"
        />
      </div>

      <SectionCard
        title="Open a new order"
        description="Pick an available table, or open a walk-in/bar tab."
        actions={
          <select
            className="rounded-md border bg-transparent px-2 py-1 text-xs"
            value={locationId ?? ""}
            onChange={(e) => setLocationId(e.target.value || undefined)}
          >
            <option value="">All outlets</option>
            {(ws.data?.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={openOrder.isPending} onClick={() => openOrder.mutate({})}>
            Walk-in / bar tab
          </Button>
          {(tables.data ?? [])
            .filter((t: any) => t.status === "available" && t.active)
            .map((t: any) => (
              <Button key={t.id} size="sm" variant="outline" disabled={openOrder.isPending} onClick={() => openOrder.mutate({ tableId: t.id })}>
                {t.name} · {t.seats}p
              </Button>
            ))}
        </div>
      </SectionCard>

      <SectionCard title="Recent orders" description={`${rows.length} order(s) in view.`}>
        {rows.length === 0 ? (
          <EmptyState title="No orders yet" description="Open a table or bar tab to start recording sales." />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r: any) => {
              const life = deriveLifecycle({ order: r });
              return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.order_number}</span>
                    <StatusChip>{STAGE_LABEL[life.stage]}</StatusChip>
                    <StatusChip>{r.status}</StatusChip>
                    <StatusChip>{r.payment_state}</StatusChip>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.order_type} · {r.guest_count} cover(s) · {money(r.total)} · cost {money(r.cost_total)}
                  </p>
                  <p className="text-xs text-muted-foreground">Next: {life.nextActionLabel} — {life.reason}</p>
                </div>
                {OPEN_STATES.includes(r.status) && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={fire.isPending} onClick={() => fire.mutate({ orderId: r.id })}>
                      <ChefHat className="mr-1 size-3.5" /> Fire
                    </Button>
                    <Button size="sm" variant="outline" disabled={changeStatus.isPending} onClick={() => changeStatus.mutate({ orderId: r.id, status: "closed" })}>
                      Close
                    </Button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
