/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { ArrowLeftRight, Boxes, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/modules/restaurant/ui/forms/SearchSelect";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { listRestaurantInventoryFn, listRestaurantUnitsFn } from "@/modules/restaurant/inventory/inventory.functions";
import {
  listRestaurantStockMovementsFn,
  recordRestaurantStockMovementFn,
} from "@/modules/restaurant/inventory/movements.functions";
import { reverseStockMovementFn } from "@/modules/restaurant/inventory/control.functions";
import { STOCK_MOVEMENT_TYPES, type StockMovementType } from "@/modules/restaurant/core/contracts";
import {
  formatDateTime,
  formatMoney,
  formatMovementLabel,
  formatQuantity,
  movementQuantityLabel,
} from "@/modules/restaurant/ui/presentation";

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
  const unitsFn = useServerFn(listRestaurantUnitsFn);
  const listFn = useServerFn(listRestaurantStockMovementsFn);
  const recordFn = useServerFn(recordRestaurantStockMovementFn);
  const reverseFn = useServerFn(reverseStockMovementFn);

  const [itemId, setItemId] = useState("");
  const [type, setType] = useState<StockMovementType>("wastage");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");

  const inventory = useQuery({
    queryKey: ["restaurant.inventory", tenantId, ws.data?.activePropertyId],
    queryFn: () => invFn({ data: { tenantId: tenantId!, propertyId: ws.data?.activePropertyId ?? undefined, lowOnly: false, limit: 200 } }),
    enabled: Boolean(tenantId),
  });
  const units = useQuery({
    queryKey: ["restaurant.inventory.units", tenantId],
    queryFn: () => unitsFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    staleTime: 5 * 60_000,
  });
  const movements = useQuery({
    queryKey: ["restaurant.movements", tenantId, ws.data?.activePropertyId],
    queryFn: () => listFn({ data: { tenantId: tenantId!, propertyId: ws.data?.activePropertyId ?? undefined, limit: 100 } }),
    enabled: Boolean(tenantId),
  });

  const unitNames = useMemo(
    () => new Map((units.data ?? []).map((unit: any) => [unit.id, unit.name || unit.code])),
    [units.data],
  );
  const itemOptions = useMemo(
    () => (inventory.data ?? []).map((item: any) => {
      const unitName = item.unit_id ? unitNames.get(item.unit_id) : undefined;
      const onHand = `${formatQuantity(item.current_quantity)}${unitName ? ` ${unitName}` : ""} on hand`;
      return { value: item.id, label: item.name, hint: onHand };
    }),
    [inventory.data, unitNames],
  );

  const record = useAdminMutation({
    mutationFn: () =>
      recordFn({
        data: {
          tenantId: tenantId!,
          propertyId: ws.data?.activePropertyId ?? undefined,
          inventoryItemId: itemId,
          movementType: type,
          quantity: Number(quantity),
          currency: ws.data?.activeProperty?.currency ?? "TZS",
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
  const currency = ws.data?.activeProperty?.currency ?? "TZS";
  const wastageCost = rows.filter((r: any) => r.movement_type === "wastage").reduce((s: number, r: any) => s + Number(r.total_cost ?? 0), 0);
  const consumptionCost = rows.filter((r: any) => r.movement_type === "consumption").reduce((s: number, r: any) => s + Number(r.total_cost ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock movements"
        description="Track stock used, wasted, received and adjusted. Every movement updates the stock balance and remains in the audit ledger."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Recorded movements" value={formatQuantity(rows.length)} hint="Latest 100 records" icon={Boxes} />
        <StatCard label="Value of stock consumed" value={formatMoney(consumptionCost, currency)} icon={ArrowLeftRight} />
        <StatCard label="Value of stock wasted" value={formatMoney(wastageCost, currency)} icon={Trash2} tone={wastageCost > 0 ? "warn" : "green"} />
      </div>

      <SectionCard title="Record a movement" description="Choose an item, select what happened and enter the quantity. LexiBite applies the correct stock direction.">
        <div className="grid gap-2 sm:grid-cols-5">
          <div className="sm:col-span-2">
            <SearchSelect
              options={itemOptions}
              value={itemId}
              onChange={(value) => setItemId(value ?? "")}
              placeholder="Choose a stock item"
              searchPlaceholder="Search stock items…"
              emptyText="No matching stock items."
              disabled={inventory.isLoading}
              className="h-11"
            />
          </div>
          <select aria-label="Movement type" className="min-h-11 rounded-md border bg-transparent px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value as StockMovementType)}>
            {STOCK_MOVEMENT_TYPES.filter((t: any) => t !== "transfer_in" && t !== "transfer_out").map((t: any) => (
              <option key={t} value={t}>
                {formatMovementLabel(t)}
              </option>
            ))}
          </select>
          <Input type="number" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" aria-label="Movement quantity" />
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason (optional)" />
        </div>
        <div className="mt-3">
          <Button size="sm" disabled={!itemId || !quantity || record.isPending} onClick={() => record.mutate(undefined)}>
            Record movement
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Movement history" description="Newest first. Each record explains the quantity moved, the stock left and the value of the movement.">
        {rows.length === 0 ? (
          <EmptyState title="No movements yet" description="Close an order or record wastage to populate the movement history." />
        ) : (
          <ul className="divide-y">
            {rows.map((r: any) => {
              const amount = Number(r.quantity ?? 0);
              const unitName = r.unit_id ? unitNames.get(r.unit_id) : undefined;
              const quantityText = `${formatQuantity(Math.abs(amount))}${unitName ? ` ${unitName}` : ""}`;
              const itemName = (inventory.data ?? []).find((item: any) => item.id === r.inventory_item_id)?.name ?? "Stock item";
              const movementCurrency = r.currency ?? currency;
              return (
                <li key={r.id} className="space-y-3 py-4">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{itemName}</span>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {formatMovementLabel(r.movement_type)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(r.occurred_at)}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                  <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{movementQuantityLabel(r.movement_type, amount)}</p>
                      <p className={`mt-1 text-base font-semibold tabular-nums ${amount < 0 ? "text-destructive" : "text-foreground"}`}>
                        {quantityText}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Stock remaining</p>
                      <p className="mt-1 text-base font-semibold tabular-nums">
                        {formatQuantity(r.balance_after)}{unitName ? ` ${unitName}` : ""}
                      </p>
                    </div>
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <p className="text-xs text-muted-foreground">Value of movement</p>
                      <p className="mt-1 text-base font-semibold tabular-nums">
                        {formatMoney(r.total_cost, movementCurrency)}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={reverse.isPending || r.movement_type === "reversal"}
                      onClick={() => onReverse(r.id)}
                    >
                      Reverse movement
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
