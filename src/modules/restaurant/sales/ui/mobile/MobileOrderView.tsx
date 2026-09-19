/* eslint-disable @typescript-eslint/no-explicit-any -- order rows are untyped at this boundary, matching PosWorkspace. */
import { Bell, Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/os/EmptyState";
import { ServiceLifecycleBar } from "../ServiceLifecycleBar";
import { money, lineTotal } from "../pos-types";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";
import { LexiBiteLoading } from "./LexiBiteLoading";

function itemMetaLabel(i: any): string {
  const bits = [
    i.notes,
    (i.modifiers ?? []).map((m: any) => m.name).join(", "),
    i.seat_number ? `Seat ${i.seat_number}` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Screen 3/section 11 — the active order. One scroll region for lines,
 * lifecycle and secondary actions; one pinned Total + "Next" CTA footer
 * that's always reachable. `life.nextAction`/`nextActionLabel` come from
 * deriveLifecycle() — the same canonical next-action engine PosWorkspace
 * uses — this screen only makes it big and obvious.
 */
export function MobileOrderView({
  data,
  onAddItems,
  onOpenPayment,
}: {
  data: LexiBiteMobilePosData;
  onAddItems: () => void;
  onOpenPayment: () => void;
}) {
  const { life, orderRow, live, cart, currency, billTotal, activeTable, canVoid, canReopen } = data;

  if (!data.orderId && data.queuedOrder) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
          <div className="mb-3 rounded-xl border border-dashed border-amber-400 bg-amber-50 p-3 text-xs text-amber-800">
            Order queued locally for {data.queuedOrder.guestCount} guest
            {data.queuedOrder.guestCount === 1 ? "" : "s"} — not yet confirmed by the server. It
            will sync automatically once this device reconnects.
          </div>
          {cart.length === 0 ? (
            <EmptyState title="No items yet" description="Add items from the menu." />
          ) : (
            <OrderLines cart={cart} currency={currency} data={data} readOnly={false} />
          )}
        </div>
        <div className="shrink-0 space-y-2 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between text-base font-semibold">
            <span>Total (queued)</span>
            <span className="tabular-nums">{money(billTotal, currency)}</span>
          </div>
          <Button variant="outline" className="min-h-12 w-full rounded-xl" onClick={onAddItems}>
            + Add items
          </Button>
          <Button
            className="min-h-14 w-full rounded-xl text-base font-bold text-white"
            style={{ background: "var(--lb-green)" }}
            disabled={cart.length === 0 || data.mutations.sendLines.isPending}
            onClick={() => data.mutations.sendLines.mutate({ fire: true })}
          >
            {data.mutations.sendLines.isPending ? "Sending…" : "Send to kitchen"}
          </Button>
        </div>
      </div>
    );
  }

  if (!data.orderId) {
    return <EmptyState title="No order selected" description="Tap a table or start a new order." />;
  }

  if (data.order.isLoading && !orderRow) return <LexiBiteLoading label="Loading order…" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-3">
        {live.length === 0 && cart.length === 0 ? (
          <EmptyState title="No items yet" description="Tap “+ Add items” to take the order." />
        ) : (
          <OrderLines cart={cart} currency={currency} data={data} readOnly={false} />
        )}

        {life && (
          <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
            <ServiceLifecycleBar life={life} compact />
            <p className="text-xs text-muted-foreground">{life.reason}</p>
          </div>
        )}

        {activeTable?.serviceRequest && (
          <div
            className={
              activeTable.serviceRequest.status === "acknowledged"
                ? "flex items-center justify-between gap-2 rounded-xl border border-amber-400 bg-amber-50 p-3"
                : "flex items-center justify-between gap-2 rounded-xl border border-destructive/50 bg-destructive/5 p-3"
            }
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Bell className="size-4" />
              {activeTable.serviceRequest.status === "acknowledged"
                ? "Acknowledged — awaiting resolution"
                : "Guest needs assistance"}
            </span>
          </div>
        )}

        <Button variant="outline" className="min-h-12 w-full rounded-xl" onClick={onAddItems}>
          + Add items
        </Button>

        <details className="rounded-xl border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium">More on this order</summary>
          <div className="mt-3 grid gap-2">
            <Button
              variant="secondary"
              className="min-h-12 w-full rounded-xl"
              disabled={cart.length > 0 || !orderRow || Number(orderRow.total ?? 0) <= 0}
              onClick={onOpenPayment}
            >
              Bill &amp; payment
            </Button>
            {orderRow?.status === "closed" && orderRow?.table_id && (
              <Button
                variant="outline"
                className="min-h-12 w-full rounded-xl"
                onClick={() => data.mutations.releaseTable.mutate({ orderId: data.orderId! })}
              >
                Release table
              </Button>
            )}
            {canReopen && orderRow?.status === "closed" && (
              <Button
                variant="outline"
                className="min-h-12 w-full rounded-xl"
                onClick={() =>
                  data.mutations.reopen.mutate({ orderId: data.orderId! })
                }
              >
                Reopen bill
              </Button>
            )}
            {canVoid && orderRow?.status !== "cancelled" && (
              <Button
                variant="ghost"
                className="min-h-12 w-full rounded-xl text-destructive"
                disabled={data.mutations.cancelBill.isPending}
                onClick={() => {
                  const reason = window.prompt("Cancel this whole order. Reason?");
                  if (reason && reason.trim().length >= 3)
                    data.mutations.cancelBill.mutate({ orderId: data.orderId!, reason: reason.trim() });
                }}
              >
                Cancel order
              </Button>
            )}
          </div>
        </details>
      </div>

      <div className="shrink-0 space-y-2 border-t-2 bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Total
          </span>
          <span className="text-2xl font-bold tabular-nums">{money(billTotal, currency)}</span>
        </div>
        {life && (
          <Button
            className="min-h-14 w-full rounded-xl text-base font-bold text-white"
            style={{ background: "var(--lb-green)" }}
            disabled={life.nextAction === "none" || life.blocked || data.mutations.sendLines.isPending}
            onClick={() => {
              // "add-items" is pure navigation (nothing to mutate), so the
              // canonical action engine's own switch is a no-op for it —
              // this is the one case the mobile CTA resolves itself rather
              // than through data.runNextAction.
              if (life.nextAction === "add-items") {
                onAddItems();
                return;
              }
              data.runNextAction((screen) => {
                if (screen === "payment") onOpenPayment();
              });
            }}
          >
            {life.nextAction === "none" ? "Nothing pending" : `${life.nextActionLabel} →`}
          </Button>
        )}
      </div>
    </div>
  );
}

function OrderLines({
  cart,
  currency,
  data,
  readOnly,
}: {
  cart: LexiBiteMobilePosData["cart"];
  currency: string;
  data: LexiBiteMobilePosData;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-2">
      {data.live.length > 0 && (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {data.live.map((i: any) => (
            <div key={i.id} className="flex items-start gap-3 p-3">
              <span className="mt-0.5 w-6 shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">
                {Number(i.quantity)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{i.description}</span>
                {itemMetaLabel(i) && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {itemMetaLabel(i)}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-semibold tabular-nums">
                  {money(Number(i.line_total ?? 0), currency)}
                </span>
                {data.canVoid && !readOnly && (
                  <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-full text-muted-foreground active:bg-muted"
                    aria-label="Void line"
                    onClick={() => {
                      const reason = window.prompt("Reason for voiding this line?");
                      if (reason && reason.trim().length >= 3) {
                        data.mutations.voidLine.mutate({ orderItemId: i.id, reason: reason.trim() });
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {cart.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Not yet sent
          </p>
          {cart.map((l) => (
            <div key={l.key} className="rounded-xl border border-dashed p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="block text-sm font-medium">{l.description}</span>
                  {l.modifiers.length > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {l.modifiers.map((m) => m.name).join(", ")}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {money(lineTotal(l), currency)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-full border active:bg-muted"
                    onClick={() => data.updateCartQty(l.key, -1)}
                    aria-label="Decrease quantity"
                  >
                    <Minus className="size-4" />
                  </button>
                  <span className="w-6 text-center text-sm font-semibold tabular-nums">
                    {l.quantity}
                  </span>
                  <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-full border active:bg-muted"
                    onClick={() => data.updateCartQty(l.key, 1)}
                    aria-label="Increase quantity"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
                <button
                  type="button"
                  className="flex size-9 items-center justify-center rounded-full text-muted-foreground active:bg-muted"
                  onClick={() => data.removeCartLine(l.key)}
                  aria-label="Remove item"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
