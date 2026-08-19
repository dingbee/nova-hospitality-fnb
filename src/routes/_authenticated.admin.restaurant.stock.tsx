/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeftRight, Boxes, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { listRestaurantInventoryFn } from "@/modules/restaurant/inventory/inventory.functions";
import {
  listRestaurantStockMovementsFn,
  recordRestaurantStockMovementFn,
} from "@/modules/restaurant/inventory/movements.functions";
import { reverseStockMovementFn } from "@/modules/restaurant/inventory/control.functions";
import { STOCK_MOVEMENT_TYPES, type StockMovementType } from "@/modules/restaurant/core/contracts";

export const Route = createFileRoute("/_authenticated/admin/restaurant/stock")({
  head: () => ({
    meta: [
      { title: "Stock Movements — Restaurant & Bar OS" },
      { name: "description", content: "Consumption, wastage, transfers and adjustments across restaurant inventory." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: StockPage,
});

function StockPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const qc = useQueryClient();

  const invFn = useServerFn(listRestaurantInventoryFn);
  const listFn = useServerFn(listRestaurantStockMovementsFn);
  const recordFn = useServerFn(recordRestaurantStockMovementFn);
  const reverseFn = useServerFn(reverseStockMovementFn);

  const [itemId, setItemId] = useState("");
  const [type, setType] = useState<StockMovementType>("wastage");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");

  const inventory = useQuery({
    queryKey: ["restaurant.inventory", tenantId],
    queryFn: () => invFn({ data: { tenantId: tenantId!, lowOnly: false, limit: 200 } }),
    enabled: Boolean(tenantId),
  });
  const movements = useQuery({
    queryKey: ["restaurant.movements", tenantId],
    queryFn: () => listFn({ data: { tenantId: tenantId!, limit: 100 } }),
    enabled: Boolean(tenantId),
  });

  const record = useAdminMutation({
    mutationFn: () =>
      recordFn({
        data: {
          tenantId: tenantId!,
          inventoryItemId: itemId,
          movementType: type,
          quantity: Number(quantity),
          currency: ws.data?.properties[0]?.currency ?? "TZS",
          reason: reason || undefined,
        },
      }),
    successMessage: "Movement recorded",
    onSuccess: () => {
      setReason("");
      void qc.invalidateQueries({ queryKey: ["restaurant.movements"] });
      void qc.invalidateQueries({ queryKey: ["restaurant.inventory"] });
    },
  });

  const reverse = useAdminMutation({
    mutationFn: (vars: { movementId: string; reason: string }) =>
      reverseFn({ data: { tenantId: tenantId!, movementId: vars.movementId, reason: vars.reason } }),
    successMessage: "Movement reversed",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["restaurant.movements"] });
      void qc.invalidateQueries({ queryKey: ["restaurant.inventory"] });
    },
  });

  const onReverse = (movementId: string) => {
    const why = window.prompt("Why is this movement being reversed? (kept on the audit trail)");
    if (!why || why.trim().length < 2) return;
    reverse.mutate({ movementId, reason: why.trim() });
  };

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }

  const rows = movements.data ?? [];
  const names = new Map((inventory.data ?? []).map((i: any) => [i.id, i.name]));
  const currency = ws.data?.properties[0]?.currency ?? "TZS";
  const wastageCost = rows.filter((r: any) => r.movement_type === "wastage").reduce((s: any, r: any) => s + Number(r.total_cost ?? 0), 0);
  const consumptionCost = rows.filter((r: any) => r.movement_type === "consumption").reduce((s: any, r: any) => s + Number(r.total_cost ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock movements"
        description="Inventory is a ledger: every consumption, wastage, transfer and adjustment is recorded and balances update automatically."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Movements (latest 100)" value={String(rows.length)} icon={Boxes} />
        <StatCard label="Consumption value" value={`${currency} ${consumptionCost.toLocaleString()}`} icon={ArrowLeftRight} />
        <StatCard label="Wastage value" value={`${currency} ${wastageCost.toLocaleString()}`} icon={Trash2} tone={wastageCost > 0 ? "warn" : "green"} />
      </div>

      <SectionCard title="Record a movement" description="Direction is derived from the movement type — you enter magnitude only.">
        <div className="grid gap-2 sm:grid-cols-5">
          <select className="rounded-md border bg-transparent px-2 py-2 text-sm sm:col-span-2" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Select stock item…</option>
            {(inventory.data ?? []).map((i: any) => (
              <option key={i.id} value={i.id}>
                {i.name} ({Number(i.current_quantity)})
              </option>
            ))}
          </select>
          <select className="rounded-md border bg-transparent px-2 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value as StockMovementType)}>
            {STOCK_MOVEMENT_TYPES.filter((t: any) => t !== "transfer_in" && t !== "transfer_out").map((t: any) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <Input type="number" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" />
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
        </div>
        <div className="mt-3">
          <Button size="sm" disabled={!itemId || !quantity || record.isPending} onClick={() => record.mutate(undefined)}>
            Record movement
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Ledger" description="Newest first. Balance shown is the stock level immediately after the movement.">
        {rows.length === 0 ? (
          <EmptyState title="No movements yet" description="Close an order or record wastage to populate the ledger." />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r: any) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <span className="font-medium">{names.get(r.inventory_item_id) ?? "Stock item"}</span>
                  <p className="text-xs text-muted-foreground">
                    {r.movement_type.replace(/_/g, " ")} · {new Date(r.occurred_at).toLocaleString()}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${Number(r.quantity) < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {Number(r.quantity) > 0 ? "+" : ""}
                    {Number(r.quantity)} → {Number(r.balance_after ?? 0)} · {currency} {Number(r.total_cost ?? 0).toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    disabled={reverse.isPending || r.movement_type === "reversal"}
                    onClick={() => onReverse(r.id)}
                  >
                    Reverse
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
