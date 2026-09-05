/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Bell,
  ChefHat,
  CreditCard,
  DoorOpen,
  Minus,
  Plus,
  Printer,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip, type StatusTone } from "@/components/os/StatusChip";
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
import { acknowledgeServiceRequestFn } from "@/modules/restaurant/service-requests/service-requests.functions";
import type { BillSplitMode } from "../bill.contracts";
import { PosItemDialog } from "./PosItemDialog";
import { PosBillDialog } from "./PosBillDialog";
import { PosPaymentDialog } from "./PosPaymentDialog";
import { PosRoomChargeDialog } from "./PosRoomChargeDialog";
import { PosMobileMoneyDialog } from "./PosMobileMoneyDialog";
import { getMobileMoneyAccountFn } from "../../payments/mobilemoney/mobilemoney.functions";
import { PosReceiptDialog } from "./PosReceiptDialog";
import { lineTotal, money, type CartLine } from "./pos-types";
import {
  deriveLifecycle,
  tableTone,
  TABLE_TONE_CLASS,
  TABLE_TONE_LABEL,
  type TableTone,
} from "./lifecycle";
import { ServiceLifecycleBar } from "./ServiceLifecycleBar";
import { OrderTimeline } from "./OrderTimeline";
import { PosMenuItemCard } from "./PosMenuItemCard";
import { beverageCategories } from "@/modules/restaurant/bar/lens";
import { BAR_STATION_TYPES } from "@/modules/restaurant/bar/contracts";
import { sendToStationLabel } from "../stationRouting";

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pos-${Date.now()}-${Math.random()}`;

const FLOOR_LEGEND: TableTone[] = ["free", "seated", "production", "ready", "billing", "attention"];

/** Presentation-only mapping from an order item's own status word to a StatusChip tone — no new state. */
function itemStatusTone(status: string): StatusTone {
  switch (status) {
    case "ready":
      return "success";
    case "preparing":
      return "warning";
    case "voided":
      return "danger";
    case "served":
      return "neutral";
    default:
      return "info"; // "ordered"
  }
}

/** Which operating environment the till is rendering: restaurant service or bar service. */
export type PosLens = "restaurant" | "bar";

/**
 * The till. Floor → bill → kitchen → payment → receipt, in one screen.
 *
 * All money and stock consequences happen server-side in the sales core; this
 * component only stages what the server has not yet accepted.
 */
export function PosWorkspace({
  lens = "restaurant",
  className,
}: { lens?: PosLens; className?: string } = {}) {
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
  const [catalogSearch, setCatalogSearch] = useState("");
  const [pickerItem, setPickerItem] = useState<any | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [roomChargeAmount, setRoomChargeAmount] = useState<number | null>(null);
  const [mobileMoneyAmount, setMobileMoneyAmount] = useState<number | null>(null);
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
  const acknowledgeServiceRequestFnCall = useServerFn(acknowledgeServiceRequestFn);

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
  const currentLocationId = (order.data as any)?.order?.location_id as string | undefined;
  const mobileMoneyAccountFn = useServerFn(getMobileMoneyAccountFn);
  const mobileMoneyAccount = useQuery({
    queryKey: ["restaurant.mobilemoney.account", tenantId, currentLocationId],
    queryFn: () =>
      mobileMoneyAccountFn({ data: { tenantId: tenantId!, locationId: currentLocationId! } }),
    enabled: Boolean(tenantId && currentLocationId),
    staleTime: 60_000,
  });
  const mobileMoneyActive = (mobileMoneyAccount.data as any)?.activation_state === "active";

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
        if (vars.fire)
          await fireFn({
            data: { tenantId: tenantId!, orderId: orderId!, orderItemIds: [], priority: 0 },
          });
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
      voidFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          orderItemId: vars.orderItemId,
          reason: vars.reason,
        },
      }),
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
          state:
            vars.method === "room_charge"
              ? "room_charged"
              : vars.method === "comp"
                ? "comped"
                : "paid",
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

  const acknowledgeRequest = useAdminMutation({
    mutationFn: (vars: { requestId: string }) =>
      acknowledgeServiceRequestFnCall({ data: { tenantId: tenantId!, requestId: vars.requestId } }),
    successMessage: "Guest request acknowledged",
    onSuccess: refresh,
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
      reopenFn({
        data: { tenantId: tenantId!, orderId: vars.orderId, reason: "Correction at the till" },
      }),
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
  const byCategory = useMemo(
    () => (categoryId ? scoped.filter((i) => i.category_id === categoryId) : scoped),
    [scoped, categoryId],
  );
  // Client-side name filter over the already-fetched catalogue — no new
  // query, no server round trip. Purely narrows what's already in `byCategory`.
  const filtered = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    if (!q) return byCategory;
    return byCategory.filter((i) =>
      String(i.name ?? "")
        .toLowerCase()
        .includes(q),
    );
  }, [byCategory, catalogSearch]);

  const serverItems = ((order.data as any)?.items ?? []) as any[];
  const live = serverItems.filter((i) => i.status !== "voided");
  const orderRow = (order.data as any)?.order;
  // Which table (if any) this bill is on — read from the floor board already
  // in memory, purely so the Bill panel can say "Table 12" instead of
  // leaving the operator to infer it from the order number.
  const activeTable = useMemo(
    () => ((board.data as any)?.tables ?? []).find((t: any) => t.id === orderRow?.table_id) ?? null,
    [board.data, orderRow?.table_id],
  );
  const stations = (catalog.data?.stations ?? []) as { id: string; stationType: string | null }[];
  const stationTypeById = useMemo(
    () => new Map(stations.map((s) => [s.id, s.stationType])),
    [stations],
  );
  const itemStationById = useMemo(
    () => new Map(items.map((i) => [i.id, i.station_id as string | null])),
    [items],
  );
  /**
   * Station types of everything about to fire: staged cart lines (proposed,
   * from the catalogue) plus already-added-but-unfired order items (resolved,
   * from the server at insert time). Feeds both the till's own "Send to X"
   * button below and `deriveLifecycle`'s "Next: X" action, so there is one
   * computation, not two — neither can claim a drink is headed to the
   * kitchen.
   */
  const pendingStationTypes = useMemo(() => {
    const pending = [
      ...cart.map((l) => (l.menuItemId ? itemStationById.get(l.menuItemId) : l.stationId) ?? null),
      ...live.filter((i) => i.status === "ordered").map((i) => i.station_id ?? null),
    ];
    return pending.map((stationId) =>
      stationId ? (stationTypeById.get(stationId) ?? null) : null,
    );
  }, [cart, live, itemStationById, stationTypeById]);
  const sendLabel = useMemo(
    () => sendToStationLabel(pendingStationTypes, BAR_STATION_TYPES),
    [pendingStationTypes],
  );
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
            stagedStationTypes: pendingStationTypes,
            receipt: (bill.data as any)?.receipt ?? null,
          })
        : null,
    [
      orderRow,
      serverItems,
      orderTickets,
      orderPayments,
      cart.length,
      pendingStationTypes,
      bill.data,
    ],
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

  /** Adjusts the quantity of a line still staged at the till — client-only state, same as removing one. Nothing already sent to the server is touched here; that's what void is for. */
  const updateCartQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l];
        const next = l.quantity + delta;
        return next <= 0 ? [] : [{ ...l, quantity: next }];
      }),
    );
  };

  if (!tenantId) {
    return (
      <EmptyState
        title="No restaurant workspace"
        description="You are not a member of a restaurant tenant yet."
      />
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-3", className)}>
      <div className="shrink-0 space-y-3">
        {/* Compact operational strip: the four figures a cashier glances at,
            in one row, not four large cards — the selling workspace below
            (Floor/Menu/Bill) is the thing this screen exists for, and it
            must own the viewport, not compete with KPI tiles for it. */}
        <div className="os-card os-fade-in flex flex-wrap items-center gap-x-6 gap-y-1.5 px-4 py-2.5">
          {[
            { label: "Open bills", value: String(stats?.openBills ?? 0), icon: Users },
            {
              label: "Open value",
              value: money(stats?.openValue ?? 0, currency),
              icon: CreditCard,
            },
            {
              label: "Revenue today",
              value: money(stats?.revenueToday ?? 0, currency),
              icon: CreditCard,
            },
            {
              label: "Average check",
              value: money(stats?.averageCheck ?? 0, currency),
              icon: ChefHat,
            },
          ].map((m) => (
            <div key={m.label} className="flex items-center gap-1.5">
              <m.icon className="size-3.5 shrink-0 text-[color:var(--os-ink-3)]" />
              <span className="text-[0.62rem] font-medium uppercase tracking-wide text-[color:var(--os-ink-3)]">
                {m.label}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[color:var(--os-ink)]">
                {m.value}
              </span>
            </div>
          ))}
        </div>

        {orderId && <GuestContextBanner tenantId={tenantId} orderId={orderId} />}
      </div>

      {/* Viewport-derived at every width, never content-driven: this grid
          always receives a definite height from the flex-col workspace
          above (h-full/min-h-0/flex-1, unconditional), and every row/column
          track below is an explicit minmax(0, Nfr) — never bare "auto" and
          never a hard pixel floor — so it always resolves to a fraction of
          that definite height regardless of how much Floor/Bill/Menu
          content exists. More tables, bill lines or menu items can only
          change what scrolls *inside* a pane; they can never grow the pane,
          this grid, the workspace, or the page.
          Below lg: Floor and the right workspace stack as two proportional
          ROWS (40fr/60fr) sharing that same fixed height, each still
          scrolling internally — not two fixed pixel boxes and not normal
          document flow. At lg+: Floor becomes the left COLUMN and the right
          workspace the right COLUMN (28fr/72fr), each spanning the grid's
          full single row. Structural, not cosmetic: Bill and Menu are never
          a second/third column beside Floor — they are two ROWS inside the
          right-hand workspace, Bill always directly above Menu, sharing the
          same horizontal bounds; Menu — the highest-frequency interaction —
          gets the larger share (~70%) of that column's height. */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,40fr)_minmax(0,60fr)] gap-3 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(200px,28fr)_minmax(420px,72fr)] xl:gap-4">
        {/* Floor */}
        <SectionCard
          title={isBar ? "Bar floor & tabs" : "Floor"}
          description={
            isBar
              ? "Counter, bar seats and tables — colour follows the tab."
              : "Colour follows the bill, not just the table row."
          }
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-2 gap-2">
              {((board.data as any)?.tables ?? []).map((t: any) => {
                const tableLife = t.order
                  ? deriveLifecycle({
                      order: t.order,
                      items: t.order.items ?? [],
                      tickets: t.order.tickets ?? [],
                    })
                  : null;
                const tone = tableTone(t, tableLife);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      t.order
                        ? setOrderId(t.order.id)
                        : openBill.mutate({ tableId: t.id, guestCount: t.seats ?? 2 })
                    }
                    className={`relative min-h-20 rounded-lg border p-3 text-left transition-colors hover:border-primary ${
                      TABLE_TONE_CLASS[tone]
                    } ${orderId && t.order?.id === orderId ? "ring-2 ring-primary" : ""}`}
                  >
                    {t.serviceRequest && (
                      <span
                        className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full border border-destructive/50 bg-destructive/10 text-destructive"
                        title="Guest needs staff"
                        aria-label="Guest needs staff"
                      >
                        <Bell className="size-3.5" />
                      </span>
                    )}
                    <span className="block text-sm font-semibold">{t.code}</span>
                    <span className="block text-xs text-muted-foreground">{t.zone ?? t.name}</span>
                    <span className="mt-1 block text-xs">
                      {t.order ? money(Number(t.order.total ?? 0), currency) : `${t.seats} seats`}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {TABLE_TONE_LABEL[tone]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="shrink-0">
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
          </div>
        </SectionCard>

        {/* Right workspace: Bill sits directly above Menu — two ROWS in one
            column, never a second/third column beside Floor. Both share this
            column's horizontal bounds automatically since they're siblings
            in the same grid track. */}
        {/* Bill's row carries a measured (not guessed) floor at lg+: header +
            the pinned Total/primary-action footer + section padding need
            ~189px with zero content — below that, no amount of internal
            scrolling can make room for Bill's own always-visible chrome.
            The floor never grows with content (badges/lines/notes all live
            in the scrollable region above the footer), so it only engages
            on genuinely short viewports, and only ever redistributes within
            this already-fixed-height row — it cannot grow this grid, the
            workspace, or the page. Below lg, Floor+RightWorkspace themselves
            are already stacked rows sharing a shorter budget (see the outer
            grid above), so a 200px floor here would consume most of that
            budget and crush Menu instead of protecting Bill; the much
            slimmer footer introduced with this floor (Total + one button,
            not the old Total-plus-five-actions block) already gives Bill
            far more headroom at every size without needing a floor there. */}
        <div className="grid h-full min-h-0 grid-rows-[minmax(0,30fr)_minmax(0,70fr)] gap-3 lg:grid-rows-[minmax(200px,30fr)_minmax(0,70fr)] xl:gap-4">
          {/* Bill */}
          <SectionCard
            title={orderRow ? `Bill ${orderRow.order_number}` : "Bill"}
            description={
              orderRow ? `${orderRow.status} · ${orderRow.payment_state}` : "Open a table to start."
            }
            actions={
              orderRow ? (
                <Badge variant="outline" className="min-h-8 px-3 text-sm font-semibold">
                  {activeTable ? `Table ${activeTable.code}` : "Walk-in / bar tab"}
                </Badge>
              ) : undefined
            }
            className="flex h-full min-h-0 flex-col overflow-hidden"
          >
            {!orderId ? (
              <EmptyState
                title="No bill selected"
                description="Tap a table or start a walk-in tab."
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                {/* Everything here scrolls as one region: status/lifecycle info,
                    line items and secondary actions can all grow arbitrarily
                    (30+ badges, 30+ lines, a long "More" list) without ever
                    touching the pinned Total/primary-action footer below —
                    that footer is the one thing a cashier must always be
                    able to reach, so its own height stays bounded (a total
                    row plus a single button) instead of competing for space
                    with whatever this bill happens to contain right now. */}
                <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pt-3">
                  {life && (
                    <div className="space-y-2 rounded-lg border bg-muted/30 p-2">
                      <ServiceLifecycleBar life={life} compact />
                      <p className="text-xs text-muted-foreground">{life.reason}</p>
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        {life.staged > 0 && <Badge variant="outline">{life.staged} staged</Badge>}
                        {life.unsent > 0 && <Badge variant="outline">{life.unsent} unsent</Badge>}
                        {life.inProduction > 0 && (
                          <Badge variant="secondary">{life.inProduction} in production</Badge>
                        )}
                        {life.ready > 0 && <Badge>{life.ready} ready</Badge>}
                        {life.balance > 0 && (
                          <Badge variant="outline">Balance {money(life.balance, currency)}</Badge>
                        )}
                        {life.delayed && <Badge variant="destructive">Delayed</Badge>}
                        {life.billRequestedAt && !life.billPresentedAt && (
                          <Badge variant="secondary">Bill asked for</Badge>
                        )}
                        {life.receiptDelivered && (
                          <Badge variant="secondary">Receipt delivered</Badge>
                        )}
                      </div>
                      {activeTable?.serviceRequest && (
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                            <Bell className="size-3.5" />
                            Guest needs assistance
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="min-h-8"
                            disabled={acknowledgeRequest.isPending}
                            onClick={() =>
                              acknowledgeRequest.mutate({
                                requestId: activeTable.serviceRequest.id,
                              })
                            }
                          >
                            Acknowledge
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {live.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        On the bill
                      </p>
                      {live.map((i) => (
                        <div
                          key={i.id}
                          className="flex items-start justify-between gap-2 rounded border bg-card p-2 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block font-medium">
                              {Number(i.quantity)} × {i.description}
                            </span>
                            {(i.modifiers ?? []).length > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {(i.modifiers ?? []).map((m: any) => m.name).join(", ")}
                              </span>
                            )}
                            <span className="mt-1 flex items-center gap-1.5">
                              {i.seat_number && (
                                <span className="text-xs text-muted-foreground">
                                  Seat {i.seat_number}
                                </span>
                              )}
                              <StatusChip tone={itemStatusTone(i.status)}>{i.status}</StatusChip>
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <span className="tabular-nums">
                              {money(Number(i.line_total ?? 0), currency)}
                            </span>
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
                    </div>
                  )}

                  {cart.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Not yet sent
                      </p>
                      {cart.map((l) => (
                        <div key={l.key} className="rounded border border-dashed p-2 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0">
                              <span className="block font-medium">{l.description}</span>
                              {l.modifiers.length > 0 && (
                                <span className="block text-xs text-muted-foreground">
                                  {l.modifiers.map((m) => m.name).join(", ")}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {money(lineTotal(l), currency)}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="icon"
                                variant="outline"
                                className="size-7"
                                onClick={() => updateCartQty(l.key, -1)}
                                aria-label="Decrease quantity"
                              >
                                <Minus className="size-3.5" />
                              </Button>
                              <span className="w-5 text-center text-xs font-medium tabular-nums">
                                {l.quantity}
                              </span>
                              <Button
                                size="icon"
                                variant="outline"
                                className="size-7"
                                onClick={() => updateCartQty(l.key, 1)}
                                aria-label="Increase quantity"
                              >
                                <Plus className="size-3.5" />
                              </Button>
                            </div>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              onClick={() => setCart((prev) => prev.filter((c) => c.key !== l.key))}
                              aria-label="Remove item"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <details className="rounded-lg border bg-card p-2">
                    <summary className="cursor-pointer text-xs font-medium">
                      Service timeline
                    </summary>
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

                  {/* Manual overrides and account-management actions: secondary
                      to the one pinned "Next" CTA below, so they live in the
                      scroll region — always reachable, never competing with
                      the primary action for the footer's guaranteed space. */}
                  <div className="grid gap-2 border-t pt-3">
                    <Button
                      className="min-h-11"
                      disabled={cart.length === 0 || sendLines.isPending}
                      onClick={() => sendLines.mutate({ fire: true })}
                    >
                      <Send className="size-4" /> {sendLabel}
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
                      <Button
                        variant="outline"
                        className="min-h-11"
                        onClick={() => releaseTable.mutate({ orderId })}
                      >
                        <DoorOpen className="size-4" /> Release table
                      </Button>
                    )}

                    <div className="mt-1 space-y-2 border-t pt-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        More
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          variant="ghost"
                          className="min-h-11"
                          onClick={() => {
                            const code = window.prompt(
                              "Move to which table code? Leave blank to detach.",
                            );
                            if (code === null) return;
                            const match = ((board.data as any)?.tables ?? []).find(
                              (t: any) =>
                                String(t.code).toLowerCase() === code.trim().toLowerCase(),
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
                        <Button
                          variant="outline"
                          className="min-h-11 w-full"
                          onClick={() => reopen.mutate({ orderId })}
                        >
                          <RotateCcw className="size-4" /> Reopen bill
                        </Button>
                      )}
                      {canVoid && orderRow?.status !== "cancelled" && (
                        <Button
                          variant="ghost"
                          className="min-h-11 w-full text-destructive"
                          disabled={cancelBill.isPending}
                          onClick={() => {
                            const reason = window.prompt("Cancel this whole bill. Reason?");
                            if (reason && reason.trim().length >= 3)
                              cancelBill.mutate({ orderId, reason: reason.trim() });
                          }}
                        >
                          Cancel bill
                        </Button>
                      )}
                      {canVoid &&
                        orderPayments.some(
                          (p: any) => Number(p.amount ?? 0) > 0 && p.state !== "refunded",
                        ) && (
                          <Button
                            variant="ghost"
                            className="min-h-11 w-full text-destructive"
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
                  </div>
                </div>

                {/* Pinned primary-action footer: bounded to a total row plus
                    one button, so it always fits inside Bill's allotted
                    height regardless of how much scrolls above it — this is
                    the one thing that must never clip, fall off-screen, or
                    need a page scroll to reach. */}
                <div className="shrink-0 space-y-2 border-t-2 pt-3">
                  <div className="flex items-center justify-between text-base font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{money(billTotal, currency)}</span>
                  </div>
                  {life && (
                    <Button
                      className="min-h-11 w-full"
                      disabled={life.nextAction === "none" || life.blocked || sendLines.isPending}
                      onClick={runNextAction}
                    >
                      Next: {life.nextActionLabel}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </SectionCard>

          {/* Menu */}
          <SectionCard
            title={isBar ? "Drinks" : "Menu"}
            description={
              isBar
                ? "Tap a drink, pick the serve (single, double, bottle, glass) and add it to the tab."
                : "Tap an item to configure and stage it on the bill."
            }
            className="flex h-full min-h-0 flex-col overflow-hidden"
          >
            <div className="shrink-0">
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder={isBar ? "Search drinks…" : "Search the menu…"}
                  className="h-10 pl-8"
                />
              </div>
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                <Button
                  variant={categoryId ? "outline" : "default"}
                  className="min-h-10 shrink-0 rounded-full"
                  onClick={() => setCategoryId(null)}
                >
                  All
                </Button>
                {categories.map((c) => (
                  <Button
                    key={c.id}
                    variant={categoryId === c.id ? "default" : "outline"}
                    className="min-h-10 shrink-0 rounded-full"
                    onClick={() => setCategoryId(c.id)}
                  >
                    {c.name}
                  </Button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <EmptyState
                  title={catalogSearch ? "No matches" : isBar ? "No drinks" : "No items"}
                  description={
                    catalogSearch
                      ? "Try a different search or category."
                      : isBar
                        ? "Publish a beverage menu to sell from the bar till."
                        : "Publish a menu to sell from this till."
                  }
                />
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {filtered.map((i) => (
                    <PosMenuItemCard
                      key={i.id}
                      item={i}
                      currency={currency}
                      disabled={!orderId || i.available === false || i.priceConfigured === false}
                      onSelect={() => setPickerItem(i)}
                    />
                  ))}
                </div>
              )}
            </div>
          </SectionCard>
        </div>
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
        mobileMoneyActive={mobileMoneyActive}
        onRequestMobileMoney={(value) => {
          setPayOpen(false);
          setMobileMoneyAmount(value);
        }}
        onClose={() => {
          setPayOpen(false);
          setShareAmount(null);
        }}
        onPay={(input) => pay.mutate(input)}
      />

      <PosMobileMoneyDialog
        open={mobileMoneyAmount != null && Boolean(orderId)}
        tenantId={tenantId}
        orderId={orderId}
        amount={mobileMoneyAmount ?? 0}
        currency={currency}
        onClose={() => setMobileMoneyAmount(null)}
        onPosted={() => {
          setMobileMoneyAmount(null);
          setShareAmount(null);
          refresh();
        }}
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
        onReprint={() =>
          receipt && showReceipt.mutate({ orderId: receipt.order_id, reprint: true })
        }
        tenantId={tenantId ?? undefined}
      />
    </div>
  );
}
