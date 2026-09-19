/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary, matching PosWorkspace. */
/**
 * LexiBite mobile POS — data and mutations.
 *
 * A self-contained consumer of the exact same canonical server functions
 * PosWorkspace.tsx calls (posBoardFn, posCatalogFn, openPosOrderFn, ...) —
 * no parallel order/payment/offline model. Query keys deliberately match
 * PosWorkspace's own (`["restaurant.pos.board", tenantId]` etc.) so the
 * desktop and mobile presentations share one React Query cache entry
 * instead of issuing duplicate requests when the viewport crosses the
 * mobile breakpoint.
 *
 * This hook owns DATA (queries, mutations, derived values). Which screen is
 * showing and any screen-local transient state (a picked menu item, a typed
 * cash amount) stays in LexiBiteMobilePos and its screens — not here.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import { getRestaurantOrderFn } from "../../sales.functions";
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
} from "../../pos.functions";
import {
  getRestaurantBillFn,
  presentRestaurantBillFn,
  refundRestaurantPaymentFn,
  releaseRestaurantTableFn,
  requestRestaurantBillFn,
} from "../../bill.functions";
import { getMobileMoneyAccountFn } from "../../../payments/mobilemoney/mobilemoney.functions";
import type { BillSplitMode } from "../../bill.contracts";
import { lineTotal, money, type CartLine } from "../pos-types";
import { deriveLifecycle, tableTone, type TableTone } from "../lifecycle";
import { beverageCategories } from "@/modules/restaurant/bar/lens";
import { BAR_STATION_TYPES } from "@/modules/restaurant/bar/contracts";
import { sendToStationLabel } from "../../stationRouting";
import { useOfflineSync } from "@/modules/restaurant/offline/useOfflineSync";
import type { PosLens } from "../PosWorkspace";

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pos-${Date.now()}-${Math.random()}`;

export function useLexiBiteMobilePos(lens: PosLens = "restaurant") {
  const isBar = lens === "bar";
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const roles = (ws.data?.roles ?? []) as readonly string[];
  const platformAdmin = ws.data?.platformAdmin ?? false;
  const canVoid = hasRestaurantCapability(roles, "sales.void", platformAdmin);
  const canReopen = hasRestaurantCapability(roles, "sales.reopen", platformAdmin);
  const canRoomCharge = hasRestaurantCapability(roles, "sales.room_charge", platformAdmin);
  const currency = ws.data?.properties?.[0]?.currency ?? "TZS";
  const workspacePropertyId = ws.data?.properties?.[0]?.id ?? null;
  const qc = useQueryClient();

  const [orderId, setOrderId] = useState<string | null>(null);
  const [queuedOrder, setQueuedOrder] = useState<{
    operationId: string;
    guestCount: number;
    tableId?: string;
  } | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
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
    refetchInterval: 8_000,
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

  const offlineSync = useOfflineSync({
    tenantId,
    propertyId: workspacePropertyId,
    outletId: currentLocationId ?? null,
  });

  const openBill = useAdminMutation({
    mutationFn: async (vars: { tableId?: string; guestCount: number }) => {
      if (offlineSync.isOffline) {
        const op = await offlineSync.queueOpenOrder({
          tenantId: tenantId!,
          propertyId: workspacePropertyId,
          locationId: vars.tableId ?? null,
          tableId: vars.tableId,
          orderType: vars.tableId ? "dine_in" : "bar",
          guestCount: vars.guestCount,
          currency,
          lines: [],
        });
        return {
          queued: true as const,
          operationId: op.operationId,
          guestCount: vars.guestCount,
          tableId: vars.tableId,
        };
      }
      const result = await openFn({
        data: {
          tenantId: tenantId!,
          tableId: vars.tableId,
          orderType: vars.tableId ? "dine_in" : "bar",
          guestCount: vars.guestCount,
          currency,
          terminalId: "pos-mobile",
          clientRequestId: openKey.current,
          lines: [],
        },
      });
      return { queued: false as const, ...(result as any) };
    },
    onSuccessToast: (data: any) =>
      data.queued ? "Order queued — will sync when reconnected" : "Order opened",
    onSuccess: (data: any) => {
      if (data.queued) {
        setQueuedOrder({
          operationId: data.operationId,
          guestCount: data.guestCount,
          tableId: data.tableId,
        });
        setOrderId(null);
      } else {
        openKey.current = newRequestId();
        setQueuedOrder(null);
        setOrderId(data.id);
      }
      setCart([]);
      refresh();
    },
  });

  const sendLines = useAdminMutation({
    mutationFn: async (vars: { fire: boolean }) => {
      const lines = cart.map((l) => ({
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
      }));

      if (offlineSync.isOffline || queuedOrder) {
        const orderRef = queuedOrder
          ? ({ kind: "local", operationId: queuedOrder.operationId } as const)
          : ({ kind: "server", orderId: orderId! } as const);
        const addOp = await offlineSync.queueAddItems(
          orderRef,
          lines,
          queuedOrder?.operationId ?? null,
        );
        if (vars.fire) {
          await offlineSync.queueFireToKitchen(orderRef, addOp.operationId);
        }
        return { queued: true as const };
      }

      const res = await addFn({
        data: { tenantId: tenantId!, orderId: orderId!, lines },
      });
      if (vars.fire) {
        await fireFn({
          data: { tenantId: tenantId!, orderId: orderId!, orderItemIds: [], priority: 0 },
        });
      }
      return { queued: false as const, ...(res as any) };
    },
    onSuccessToast: (data: any) => (data.queued ? "Queued — will send when reconnected" : "Sent"),
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
    successMessage: "Order moved",
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
      if (data?.receipt) setReceipt(data.receipt);
      refresh();
    },
  });

  const requestBill = useAdminMutation({
    mutationFn: () => requestBillFn({ data: { tenantId: tenantId!, orderId: orderId! } }),
    successMessage: "Bill started",
    onSuccess: refresh,
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
      reopenFn({
        data: { tenantId: tenantId!, orderId: vars.orderId, reason: "Correction at the till" },
      }),
    successMessage: "Bill reopened",
    onSuccess: refresh,
  });

  const cancelBill = useAdminMutation({
    mutationFn: (vars: { orderId: string; reason: string }) =>
      cancelFn({ data: { tenantId: tenantId!, orderId: vars.orderId, reason: vars.reason } }),
    onSuccessToast: (d: any) =>
      d?.reversal?.reversed
        ? `Order cancelled — ${d.reversal.reversed} stock movement(s) reversed`
        : "Order cancelled",
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
  const tables = ((board.data as any)?.tables ?? []) as any[];
  const activeTable = useMemo(
    () => tables.find((t: any) => t.id === orderRow?.table_id) ?? null,
    [tables, orderRow?.table_id],
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
    [orderRow, serverItems, orderTickets, orderPayments, cart.length, pendingStationTypes, bill.data],
  );

  const tableToneFor = (t: any): TableTone => {
    const tLife = t.order
      ? deriveLifecycle({ order: t.order, items: t.order.items ?? [], tickets: t.order.tickets ?? [] })
      : null;
    return tableTone(t, tLife);
  };

  /** One primary action per state — same switch PosWorkspace.runNextAction uses; screen navigation for actions that open a view (present-bill/mark-served/take-payment/settle-balance) is handled by the caller via `onNavigate`, since the mobile shell owns screen routing, not this data hook. */
  const runNextAction = (onNavigate: (screen: "payment" | "order") => void) => {
    if (!life || !orderId) return;
    switch (life.nextAction) {
      case "send-to-kitchen":
        sendLines.mutate({ fire: true });
        break;
      case "request-bill":
        requestBill.mutate(undefined as never);
        break;
      case "present-bill":
        presentBill.mutate(undefined as never);
        break;
      case "mark-served":
      case "take-payment":
      case "settle-balance":
        onNavigate("payment");
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

  const updateCartQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l];
        const next = l.quantity + delta;
        return next <= 0 ? [] : [{ ...l, quantity: next }];
      }),
    );
  };

  const removeCartLine = (key: string) => setCart((prev) => prev.filter((l) => l.key !== key));
  const addCartLine = (line: CartLine) => setCart((prev) => [...prev, line]);

  // Outlet label for the header: the location the active order is on, else
  // the first location this staff member can see, else the property name —
  // never a hardcoded outlet. Mirrors how PosWorkspace derives
  // `currentLocationId`, just surfaced as a human label.
  const locations = (ws.data?.locations ?? []) as { id: string; name: string }[];
  const outletName =
    locations.find((l) => l.id === currentLocationId)?.name ??
    locations[0]?.name ??
    ws.data?.properties?.[0]?.name ??
    "LexiBite";

  return {
    ws,
    tenantId,
    roles,
    platformAdmin,
    canVoid,
    canReopen,
    canRoomCharge,
    currency,
    outletName,
    lens,

    orderId,
    setOrderId,
    queuedOrder,
    setQueuedOrder,
    cart,
    addCartLine,
    updateCartQty,
    removeCartLine,
    setCart,

    categoryId,
    setCategoryId,
    catalogSearch,
    setCatalogSearch,
    splitMode,
    setSplitMode,
    ways,
    setWays,
    shareAmount,
    setShareAmount,
    receipt,
    setReceipt,

    board,
    catalog,
    order,
    bill,
    mobileMoneyAccount,
    mobileMoneyActive,
    offlineSync,
    refresh,

    items,
    categories,
    filtered,
    tables,
    tableToneFor,

    serverItems,
    live,
    orderRow,
    activeTable,
    pendingStationTypes,
    sendLabel,
    orderTickets,
    orderPayments,
    billTotal,
    stats,
    life,

    mutations: {
      openBill,
      sendLines,
      voidLine,
      transfer,
      pay,
      requestBill,
      presentBill,
      releaseTable,
      refund,
      reopen,
      cancelBill,
      showReceipt,
    },
    runNextAction,
    money,
  };
}

export type LexiBiteMobilePosData = ReturnType<typeof useLexiBiteMobilePos>;
