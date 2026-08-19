/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChefHat, CreditCard, DoorOpen, Printer, ReceiptText, RotateCcw, Send, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { GuestContextBanner } from "./GuestContextBanner";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import { getRestaurantOrderFn } from "../sales.functions";
import { fireRestaurantOrderFn } from "@/modules/restaurant/kitchen/kitchen.functions";
import {
  addPosLinesFn,
  openPosOrderFn,
  posBoardFn,
  posCatalogFn,
  posReceiptFn,
  reopenPosOrderFn,
  cancelPosOrderFn,
  takePosPaymentFn,
  transferPosOrderFn,
  voidPosLineFn,
} from "../pos.functions";
import {
  getRestaurantBillFn,
  presentRestaurantBillFn,
  refundRestaurantPaymentFn,
  releaseRestaurantTableFn,
  requestRestaurantBillFn,
} from "../bill.functions";
import type { BillSplitMode } from "../bill.contracts";
import { PosItemDialog } from "./PosItemDialog";
import { PosBillDialog } from "./PosBillDialog";
import { PosPaymentDialog } from "./PosPaymentDialog";
import { PosRoomChargeDialog } from "./PosRoomChargeDialog";
import { PosReceiptDialog } from "./PosReceiptDialog";
import { lineTotal, money, type CartLine } from "./pos-types";
import { deriveLifecycle, tableTone, TABLE_TONE_CLASS, TABLE_TONE_LABEL, type TableTone } from "./lifecycle";
import { ServiceLifecycleBar } from "./ServiceLifecycleBar";
import { OrderTimeline } from "./OrderTimeline";
import { beverageCategories } from "@/modules/restaurant/bar/lens";

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `pos-${Date.now()}-${Math.random()}`;

const FLOOR_LEGEND: TableTone[] = ["free", "seated", "production", "ready", "billing", "attention"];

/** Which operating environment the till is rendering: restaurant service or bar service. */
export type PosLens = "restaurant" | "bar";

/**
 * The till. Floor → bill → kitchen → payment → receipt, in one screen.
 *
 * All money and stock consequences happen server-side in the sales core; this
 * component only stages what the server has not yet accepted.
 */
export function PosWorkspace({ lens = "restaurant" }: { lens?: PosLens } = {}) {
  const isBar = lens === "bar";
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = (ws.data?.roles ?? []) as readonly string[];
  const platformAdmin = ws.data?.platformAdmin ?? false;
  const canVoid = hasRestaurantCapability(roles, "sales.void", platformAdmin);
  const canReopen = hasRestaurantCapability(roles, "sales.reopen", platformAdmin);
  const canRoomCharge = hasRestaurantCapability(roles, "sales.room_charge", platformAdmin);
  const currency = ws.data?.properties?.[0]?.currency ?? "TZS";
  const qc = useQueryClient();

  const [orderId, setOrderId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [pickerItem, setPickerItem] = useState<any | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [roomChargeAmount, setRoomChargeAmount] = useState<number | null>(null);
  const [billOpen, setBillOpen] = useState(false);
  const [splitMode, setSplitMode] = useState<BillSplitMode>("none");
  const [ways, setWays] = useState(2);
  const [shareAmount, setShareAmount] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<any | null>(null);
  const openKey = useRef<string>(newRequestId());
  const payKey = useRef<string>(newRequestId());
  const refundKey = useRef<string>(newRequestId());

  const boardFn = useServerFn(posBoardFn);
  const catalogFn = useServerFn(posCatalogFn);
  const orderFn = useServerFn(getRestaurantOrderFn);
  const openFn = useServerFn(openPosOrderFn);
  const addFn = useServerFn(addPosLinesFn);
  const voidFn = useServerFn(voidPosLineFn);
  const transferFn = useServerFn(transferPosOrderFn);
  const payFn = useServerFn(takePosPaymentFn);
  const reopenFn = useServerFn(reopenPosOrderFn);
  const cancelFn = useServerFn(cancelPosOrderFn);
  const receiptFn = useServerFn(posReceiptFn);
  const fireFn = useServerFn(fireRestaurantOrderFn);
  const billFn = useServerFn(getRestaurantBillFn);
  const requestBillFn = useServerFn(requestRestaurantBillFn);
  const presentBillFn = useServerFn(presentRestaurantBillFn);
  const releaseTableFn = useServerFn(releaseRestaurantTableFn);
  const refundFn = useServerFn(refundRestaurantPaymentFn);

  const board = useQuery({
    queryKey: ["restaurant.pos.board", tenantId],
    queryFn: () => boardFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    refetchInterval: 20_000,
  });
  const catalog = useQuery({
    queryKey: ["restaurant.pos.catalog", tenantId],
    queryFn: () => catalogFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
    staleTime: 120_000,
  });
  const order = useQuery({
    queryKey: ["restaurant.pos.order", tenantId, orderId],
    queryFn: () => orderFn({ data: { tenantId: tenantId!, orderId: orderId! } }),
    enabled: Boolean(tenantId && orderId),
    refetchInterval: 20_000,
  });
  const bill = useQuery({
    queryKey: ["restaurant.pos.bill", tenantId, orderId, splitMode, ways],
    queryFn: () => billFn({ data: { tenantId: tenantId!, orderId: orderId!, splitMode, ways } }),
    enabled: Boolean(tenantId && orderId),
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["restaurant.pos.board"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.pos.order"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.pos.bill"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.tickets"] });
    void qc.invalidateQueries({ queryKey: ["restaurant.orders"] });
  };

  const openBill = useAdminMutation({
    mutationFn: (vars: { tableId?: string; guestCount: number }) =>
      openFn({
        data: {
          tenantId: tenantId!,
          tableId: vars.tableId,
          orderType: vars.tableId ? "dine_in" : "bar",
          guestCount: vars.guestCount,
          currency,
          terminalId: "pos-web",
          clientRequestId: openKey.current,
          lines: [],
        },
      }),
    successMessage: "Bill opened",
    onSuccess: (data: any) => {
      openKey.current = newRequestId();
      setOrderId(data.id);
      setCart([]);
      refresh();
    },
  });

  const sendLines = useAdminMutation({
    mutationFn: (vars: { fire: boolean }) =>
      addFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          lines: cart.map((l) => ({
            menuItemId: l.menuItemId,
            variantId: l.variantId,
            stationId: l.stationId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: 0,
            seatNumber: l.seatNumber,
            course: l.course,
            notes: l.notes,
            guestNotes: l.guestNotes,
            modifiers: l.modifiers,
          })),
        },
      }).then(async (res: any) => {
        if (vars.fire) await fireFn({ data: { tenantId: tenantId!, orderId: orderId!, orderItemIds: [], priority: 0 } });
        return res;
      }),
    successMessage: "Sent",
    onSuccess: () => {
      setCart([]);
      refresh();
    },
  });

  const voidLine = useAdminMutation({
    mutationFn: (vars: { orderItemId: string; reason: string }) =>
      voidFn({ data: { tenantId: tenantId!, orderId: orderId!, orderItemId: vars.orderItemId, reason: vars.reason } }),
    successMessage: "Line voided",
    onSuccess: refresh,
  });

  const transfer = useAdminMutation({
    mutationFn: (vars: { tableId: string | null }) =>
      transferFn({ data: { tenantId: tenantId!, orderId: orderId!, tableId: vars.tableId } }),
    successMessage: "Bill moved",
    onSuccess: refresh,
  });

  const pay = useAdminMutation({
    mutationFn: (vars: { method: any; amount: number; tendered?: number; reference?: string }) =>
      payFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          clientRequestId: payKey.current,
          method: vars.method,
          amount: vars.amount,
          tendered: vars.tendered,
          reference: vars.reference,
          state: vars.method === "room_charge" ? "room_charged" : vars.method === "comp" ? "comped" : "paid",
          closeWhenSettled: true,
        },
      }),
    successMessage: "Payment recorded",
    onSuccess: (data: any) => {
      payKey.current = newRequestId();
      setShareAmount(null);
      if (data?.receipt) {
        setReceipt(data.receipt);
        setPayOpen(false);
        setBillOpen(false);
      }
      refresh();
    },
  });

  const requestBill = useAdminMutation({
    mutationFn: () => requestBillFn({ data: { tenantId: tenantId!, orderId: orderId! } }),
    successMessage: "Bill started",
    onSuccess: () => {
      setBillOpen(true);
      refresh();
    },
  });

  const presentBill = useAdminMutation({
    mutationFn: () => presentBillFn({ data: { tenantId: tenantId!, orderId: orderId! } }),
    successMessage: "Bill presented to the guest",
    onSuccess: () => {
      if (typeof window !== "undefined") window.print();
      refresh();
    },
  });

  const releaseTable = useAdminMutation({
    mutationFn: (vars: { orderId: string }) =>
      releaseTableFn({ data: { tenantId: tenantId!, orderId: vars.orderId } }),
    successMessage: "Table released",
    onSuccess: () => {
      setOrderId(null);
      setReceipt(null);
      refresh();
    },
  });

  const refund = useAdminMutation({
    mutationFn: (vars: { paymentId: string; amount: number; reason: string }) =>
      refundFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          paymentId: vars.paymentId,
          amount: vars.amount,
          reason: vars.reason,
          clientRequestId: refundKey.current,
        },
      }),
    successMessage: "Refund recorded",
    onSuccess: () => {
      refundKey.current = newRequestId();
      refresh();
    },
  });

  const reopen = useAdminMutation({
    mutationFn: (vars: { orderId: string }) =>
      reopenFn({ data: { tenantId: tenantId!, orderId: vars.orderId, reason: "Correction at the till" } }),
    successMessage: "Bill reopened",
    onSuccess: refresh,
  });

  // Cancelling a whole bill is a governed correction, not a delete: the server
  // decides whether it is allowed and unwinds any stock the sale consumed.
  const cancelBill = useAdminMutation({
    mutationFn: (vars: { orderId: string; reason: string }) =>
      cancelFn({ data: { tenantId: tenantId!, orderId: vars.orderId, reason: vars.reason } }),
    onSuccessToast: (d: any) =>
      d?.reversal?.reversed
        ? `Bill cancelled — ${d.reversal.reversed} stock movement(s) reversed`
        : "Bill cancelled",
    onSuccess: () => {
      setOrderId(null);
      setCart([]);
      refresh();
    },
  });

  const showReceipt = useAdminMutation({
    mutationFn: (vars: { orderId: string; reprint: boolean }) =>
      receiptFn({ data: { tenantId: tenantId!, orderId: vars.orderId, reprint: vars.reprint } }),
    silentSuccess: true,
    onSuccess: (data: any) => setReceipt(data),
  });

  const items = (catalog.data?.items ?? []) as any[];
  const allCategories = (catalog.data?.categories ?? []) as any[];
  /** In the bar lens the catalogue narrows to beverage categories; falls back to all when none are tagged. */
  const barCategories = useMemo(() => beverageCategories<any>(allCategories), [allCategories]);
  const categories = isBar && barCategories.length > 0 ? barCategories : allCategories;
  const scoped = useMemo(() => {
    if (!isBar || barCategories.length === 0) return items;
    const ids = new Set(barCategories.map((c) => c.id));
    return items.filter((i) => ids.has(i.category_id));
  }, [items, isBar, barCategories]);
  const filtered = useMemo(
    () => (categoryId ? scoped.filter((i) => i.category_id === categoryId) : scoped),
    [scoped, categoryId],
  );

  const serverItems = ((order.data as any)?.items ?? []) as any[];
  const live = serverItems.filter((i) => i.status !== "voided");
  const orderRow = (order.data as any)?.order;
  const orderTickets = ((order.data as any)?.tickets ?? []) as any[];
  const orderPayments = ((order.data as any)?.payments ?? []) as any[];
  const billTotal = Number(orderRow?.total ?? 0) + cart.reduce((s, l) => s + lineTotal(l), 0);
  const stats = (board.data as any)?.stats;

  const life = useMemo(
    () =>
      orderRow
        ? deriveLifecycle({
            order: orderRow,
            items: serverItems,
            tickets: orderTickets,
            payments: orderPayments,
            stagedCount: cart.length,
            receipt: (bill.data as any)?.receipt ?? null,
          })
        : null,
    [orderRow, serverItems, orderTickets, orderPayments, cart.length, bill.data],
  );

  /** One primary action per state — the till never asks "what now?". */
  const runNextAction = () => {
    if (!life || !orderId) return;
    switch (life.nextAction) {
      case "send-to-kitchen":
        sendLines.mutate({ fire: true });
        break;
      case "request-bill":
        requestBill.mutate(undefined as never);
        break;
      case "present-bill":
        setBillOpen(true);
        break;
      case "mark-served":
      case "take-payment":
      case "settle-balance":
        setBillOpen(true);
        break;
      case "print-receipt":
        showReceipt.mutate({ orderId, reprint: false });
        break;
      case "deliver-receipt":
        if ((bill.data as any)?.receipt) setReceipt((bill.data as any).receipt);
        else showReceipt.mutate({ orderId, reprint: false });
        break;
      case "release-table":
        releaseTable.mutate({ orderId });
        break;
      default:
        break;
    }
  };

  if (!tenantId) {
    return <EmptyState title="No restaurant workspace" description="You are not a member of a restaurant tenant yet." />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open bills" value={String(stats?.openBills ?? 0)} icon={Users} />
        <StatCard label="Open value" value={money(stats?.openValue ?? 0, currency)} icon={CreditCard} />
        <StatCard label="Revenue today" value={money(stats?.revenueToday ?? 0, currency)} icon={CreditCard} />
        <StatCard label="Average check" value={money(stats?.averageCheck ?? 0, currency)} icon={ChefHat} />
      </div>

      {orderId && <GuestContextBanner tenantId={tenantId} orderId={orderId} />}

      {/* Tablet-first: 8"/10" portrait (<1024px) stays single column so the
          floor, catalogue and bill each keep full-width touch targets. */}
      <div className="grid gap-4 lg:grid-cols-2 min-[1700px]:grid-cols-[260px_minmax(0,1fr)_340px]">
        {/* Floor */}
        <SectionCard
          title={isBar ? "Bar floor & tabs" : "Floor"}
          description={isBar ? "Counter, bar seats and tables — colour follows the tab." : "Colour follows the bill, not just the table row."}
        >
          <div className="grid grid-cols-2 gap-2">
            {((board.data as any)?.tables ?? []).map((t: any) => {
              const tableLife = t.order ? deriveLifecycle({ order: t.order }) : null;
              const tone = tableTone(t, tableLife);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    t.order ? setOrderId(t.order.id) : openBill.mutate({ tableId: t.id, guestCount: t.seats ?? 2 })
                  }
                  className={`min-h-20 rounded-lg border p-3 text-left transition-colors hover:border-primary ${
                    TABLE_TONE_CLASS[tone]
                  } ${orderId && t.order?.id === orderId ? "ring-2 ring-primary" : ""}`}
                >
                  <span className="block text-sm font-semibold">{t.code}</span>
                  <span className="block text-xs text-muted-foreground">{t.zone ?? t.name}</span>
                  <span className="mt-1 block text-xs">
                    {t.order ? money(Number(t.order.total ?? 0), currency) : `${t.seats} seats`}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{TABLE_TONE_LABEL[tone]}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {FLOOR_LEGEND.map((tone) => (
              <span
                key={tone}
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${TABLE_TONE_CLASS[tone]}`}
              >
                {TABLE_TONE_LABEL[tone]}
              </span>
            ))}
          </div>
          <Button
            variant="outline"
            className="mt-3 min-h-11 w-full"
            onClick={() => openBill.mutate({ guestCount: 1 })}
            disabled={openBill.isPending}
          >
            {isBar ? "Open counter tab" : "Walk-in / bar tab"}
          </Button>
        </SectionCard>

        {/* Catalogue */}
        <SectionCard
          title={isBar ? "Drinks" : "Menu"}
          description={
            isBar
              ? "Tap a drink, pick the serve (single, double, bottle, glass) and add it to the tab."
              : "Tap an item to configure and stage it on the bill."
          }
        >
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant={categoryId ? "outline" : "default"} className="min-h-10" onClick={() => setCategoryId(null)}>
              All
            </Button>
            {categories.map((c) => (
              <Button
                key={c.id}
                variant={categoryId === c.id ? "default" : "outline"}
                className="min-h-10"
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </Button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={isBar ? "No drinks" : "No items"}
              description={isBar ? "Publish a beverage menu to sell from the bar till." : "Publish a menu to sell from this till."}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {filtered.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  disabled={!orderId || i.available === false}
                  onClick={() => setPickerItem(i)}
                  className="min-h-20 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary disabled:opacity-50"
                >
                  <span className="block text-sm font-medium">{i.name}</span>
                  <span className="block text-xs text-muted-foreground">{money(Number(i.price ?? 0), currency)}</span>
                  {(i.variants ?? []).length > 0 && (
                    <Badge variant="secondary" className="mt-1">
                      {i.variants.length} variants
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Bill */}
        <SectionCard
          title={orderRow ? `Bill ${orderRow.order_number}` : "Bill"}
          description={orderRow ? `${orderRow.status} · ${orderRow.payment_state}` : "Open a table to start."}
        >
          {!orderId ? (
            <EmptyState title="No bill selected" description="Tap a table or start a walk-in tab." />
          ) : (
            <div className="space-y-3">
              {life && (
                <div className="space-y-2 rounded-lg border bg-muted/30 p-2">
                  <ServiceLifecycleBar life={life} compact />
                  <p className="text-xs text-muted-foreground">{life.reason}</p>
                  <div className="flex flex-wrap gap-1 text-[11px]">
                    {life.staged > 0 && <Badge variant="outline">{life.staged} staged</Badge>}
                    {life.unsent > 0 && <Badge variant="outline">{life.unsent} unsent</Badge>}
                    {life.inProduction > 0 && <Badge variant="secondary">{life.inProduction} in production</Badge>}
                    {life.ready > 0 && <Badge>{life.ready} ready</Badge>}
                    {life.balance > 0 && <Badge variant="outline">Balance {money(life.balance, currency)}</Badge>}
                    {life.delayed && <Badge variant="destructive">Delayed</Badge>}
                    {life.billRequestedAt && !life.billPresentedAt && <Badge variant="secondary">Bill asked for</Badge>}
                    {life.receiptDelivered && <Badge variant="secondary">Receipt delivered</Badge>}
                  </div>
                  <Button
                    className="min-h-11 w-full"
                    disabled={life.nextAction === "none" || life.blocked || sendLines.isPending}
                    onClick={runNextAction}
                  >
                    Next: {life.nextActionLabel}
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                {live.map((i) => (
                  <div key={i.id} className="flex items-start justify-between gap-2 rounded border bg-card p-2 text-sm">
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {Number(i.quantity)} × {i.description}
                      </span>
                      {(i.modifiers ?? []).length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {(i.modifiers ?? []).map((m: any) => m.name).join(", ")}
                        </span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {i.seat_number ? `Seat ${i.seat_number} · ` : ""}
                        {i.status}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="tabular-nums">{money(Number(i.line_total ?? 0), currency)}</span>
                      {canVoid && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          onClick={() => {
                            const reason = window.prompt("Reason for voiding this line?");
                            if (reason && reason.trim().length >= 3) {
                              voidLine.mutate({ orderItemId: i.id, reason: reason.trim() });
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </span>
                  </div>
                ))}

                {cart.map((l) => (
                  <div key={l.key} className="flex items-start justify-between gap-2 rounded border border-dashed p-2 text-sm">
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {l.quantity} × {l.description}
                      </span>
                      {l.modifiers.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {l.modifiers.map((m) => m.name).join(", ")}
                        </span>
                      )}
                      <span className="block text-xs text-muted-foreground">staged</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="tabular-nums">{money(lineTotal(l), currency)}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        onClick={() => setCart((prev) => prev.filter((c) => c.key !== l.key))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{money(billTotal, currency)}</span>
              </div>

              <div className="grid gap-2">
                <Button
                  className="min-h-11"
                  disabled={cart.length === 0 || sendLines.isPending}
                  onClick={() => sendLines.mutate({ fire: true })}
                >
                  <Send className="size-4" /> Send to kitchen
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={cart.length === 0 || sendLines.isPending}
                  onClick={() => sendLines.mutate({ fire: false })}
                >
                  Hold on bill
                </Button>
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={cart.length > 0 || !orderRow || Number(orderRow.total ?? 0) <= 0}
                  onClick={() => setBillOpen(true)}
                >
                  <ReceiptText className="size-4" /> Bill &amp; payment
                </Button>
                {orderRow?.status === "closed" && orderRow?.table_id && (
                  <Button variant="outline" className="min-h-11" onClick={() => releaseTable.mutate({ orderId })}>
                    <DoorOpen className="size-4" /> Release table
                  </Button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => {
                      const code = window.prompt("Move to which table code? Leave blank to detach.");
                      if (code === null) return;
                      const match = ((board.data as any)?.tables ?? []).find(
                        (t: any) => String(t.code).toLowerCase() === code.trim().toLowerCase(),
                      );
                      transfer.mutate({ tableId: match?.id ?? null });
                    }}
                  >
                    Move table
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => showReceipt.mutate({ orderId: orderId, reprint: false })}
                  >
                    <Printer className="size-4" /> Receipt
                  </Button>
                </div>
                {canReopen && orderRow?.status === "closed" && (
                  <Button variant="outline" className="min-h-11" onClick={() => reopen.mutate({ orderId })}>
                    <RotateCcw className="size-4" /> Reopen bill
                  </Button>
                )}
                {canVoid && orderRow?.status !== "cancelled" && (
                  <Button
                    variant="ghost"
                    className="min-h-11 text-destructive"
                    disabled={cancelBill.isPending}
                    onClick={() => {
                      const reason = window.prompt("Cancel this whole bill. Reason?");
                      if (reason && reason.trim().length >= 3) cancelBill.mutate({ orderId, reason: reason.trim() });
                    }}
                  >
                    Cancel bill
                  </Button>
                )}
                {canVoid && orderPayments.some((p: any) => Number(p.amount ?? 0) > 0 && p.state !== "refunded") && (
                  <Button
                    variant="ghost"
                    className="min-h-11 text-destructive"
                    onClick={() => {
                      const target = orderPayments.find(
                        (p: any) => Number(p.amount ?? 0) > 0 && p.state !== "refunded",
                      );
                      if (!target) return;
                      const reason = window.prompt(
                        `Refund ${money(Number(target.amount), currency)} taken by ${target.method}. Reason?`,
                      );
                      if (reason && reason.trim().length >= 3) {
                        refund.mutate({
                          paymentId: target.id,
                          amount: Number(target.amount),
                          reason: reason.trim(),
                        });
                      }
                    }}
                  >
                    <CreditCard className="size-4" /> Refund a payment
                  </Button>
                )}
              </div>

              <details className="rounded-lg border bg-card p-2">
                <summary className="cursor-pointer text-xs font-medium">Service timeline</summary>
                <div className="mt-2">
                  <OrderTimeline
                    order={orderRow}
                    items={serverItems}
                    tickets={orderTickets}
                    payments={orderPayments}
                    receipt={(bill.data as any)?.receipt ?? null}
                  />
                </div>
              </details>
            </div>
          )}
        </SectionCard>
      </div>

      <PosItemDialog
        item={pickerItem}
        groups={(catalog.data?.modifierGroups ?? []) as any[]}
        currency={currency}
        seats={Number(orderRow?.guest_count ?? 0)}
        tenantId={tenantId}
        onClose={() => setPickerItem(null)}
        onAdd={(line) => setCart((prev) => [...prev, line])}
      />

      <PosPaymentDialog
        open={payOpen}
        currency={currency}
        total={Number(orderRow?.total ?? 0)}
        paid={Number(orderRow?.paid_total ?? 0)}
        pending={pay.isPending}
        suggestedAmount={shareAmount}
        canRoomCharge={canRoomCharge}
        onRoomCharge={(value) => {
          setPayOpen(false);
          setRoomChargeAmount(value);
        }}
        onClose={() => {
          setPayOpen(false);
          setShareAmount(null);
        }}
        onPay={(input) => pay.mutate(input)}
      />

      <PosRoomChargeDialog
        open={roomChargeAmount != null && Boolean(orderId)}
        tenantId={tenantId}
        orderId={orderId}
        amount={roomChargeAmount ?? 0}
        currency={currency}
        onClose={() => setRoomChargeAmount(null)}
        onPosted={(result) => {
          setRoomChargeAmount(null);
          setShareAmount(null);
          setBillOpen(false);
          if (result?.receipt) setReceipt(result.receipt);
          refresh();
        }}
      />

      <PosBillDialog
        open={billOpen && Boolean(orderId)}
        bill={bill.data as any}
        loading={bill.isLoading}
        currency={currency}
        splitMode={splitMode}
        ways={ways}
        presenting={presentBill.isPending}
        onSplitMode={setSplitMode}
        onWays={setWays}
        onClose={() => setBillOpen(false)}
        onPresent={() => presentBill.mutate(undefined as never)}
        onPayShare={(amount) => {
          setShareAmount(amount);
          setBillOpen(false);
          setPayOpen(true);
        }}
      />

      <PosReceiptDialog
        receipt={receipt}
        onClose={() => setReceipt(null)}
        onReprint={() => receipt && showReceipt.mutate({ orderId: receipt.order_id, reprint: true })}
        tenantId={tenantId ?? undefined}
      />
    </div>
  );
}