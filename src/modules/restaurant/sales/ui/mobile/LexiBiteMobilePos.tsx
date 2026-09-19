/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue/order rows are untyped at this boundary, matching PosWorkspace. */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/os/EmptyState";
import { PosRoomChargeDialog } from "../PosRoomChargeDialog";
import { PosMobileMoneyDialog } from "../PosMobileMoneyDialog";
import type { PosLens } from "../PosWorkspace";
import { useLexiBiteMobilePos } from "./useLexiBiteMobilePos";
import { MobilePosHeader } from "./MobilePosHeader";
import { MobilePosBottomNav } from "./MobilePosBottomNav";
import { MobileOfflineBanner } from "./MobileOfflineBanner";
import { MobileTablesView } from "./MobileTablesView";
import { MobileMenuView } from "./MobileMenuView";
import { MobileItemSheet } from "./MobileItemSheet";
import { MobileOrderView } from "./MobileOrderView";
import { MobilePaymentView } from "./MobilePaymentView";
import { MobilePaymentSuccessView } from "./MobilePaymentSuccessView";
import { MobileReceiptsView } from "./MobileReceiptsView";
import { MobileReceiptDetailView } from "./MobileReceiptDetailView";
import { MobileKitchenView } from "./MobileKitchenView";
import { MobileMoreView } from "./MobileMoreView";
import type { MobileScreen } from "./types";
import { LexiBiteLoading } from "./LexiBiteLoading";

/** Screens reached by drilling in (get a back arrow) vs. primary bottom-nav destinations (don't). */
const DRILL_IN_SCREENS = new Set<MobileScreen>(["menu", "order", "payment", "receiptDetail"]);

/**
 * The dedicated LexiBite mobile POS presentation — the same canonical
 * data/mutations PosWorkspace.tsx uses (see useLexiBiteMobilePos), a
 * purpose-built phone shell instead of the desktop three-column workspace.
 * PosWorkspace renders this in place of its own JSX below the mobile
 * breakpoint; nothing here talks to the server directly.
 */
export function LexiBiteMobilePos({
  lens = "restaurant",
  className,
}: { lens?: PosLens; className?: string } = {}) {
  const data = useLexiBiteMobilePos(lens);
  const [screen, setScreen] = useState<MobileScreen>("tables");
  const [pickerItem, setPickerItem] = useState<any | null>(null);
  const [roomChargeAmount, setRoomChargeAmount] = useState<number | null>(null);
  const [mobileMoneyAmount, setMobileMoneyAmount] = useState<number | null>(null);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);

  // A table/order picked from Tables (or the board updating under an
  // already-open order) should land the operator on the order screen, not
  // silently stay on Tables — mirrors PosWorkspace always showing whichever
  // order is selected.
  const openOrder = (orderId: string) => {
    data.setOrderId(orderId);
    setScreen("order");
  };

  const startOrder = (tableId: string, guestCount: number) => {
    data.mutations.openBill.mutate(
      { tableId, guestCount },
      { onSuccess: () => setScreen("order") },
    );
  };

  const startWalkIn = () => {
    data.setCart([]);
    data.mutations.openBill.mutate({ guestCount: 1 }, { onSuccess: () => setScreen("order") });
  };

  if (data.ws.isLoading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <LexiBiteLoading label="Loading LexiBite POS…" />
      </div>
    );
  }

  if (!data.tenantId) {
    return (
      <EmptyState
        title="No restaurant workspace"
        description="You are not a member of a restaurant tenant yet."
      />
    );
  }

  const tableLabel = data.activeTable
    ? `Table ${data.activeTable.code}`
    : data.orderRow
      ? `Order ${data.orderRow.order_number}`
      : "New Order";
  const orderSubtitle = data.orderRow
    ? `${data.orderRow.guest_count ?? "?"} pax`
    : data.queuedOrder
      ? `${data.queuedOrder.guestCount} pax · queued`
      : undefined;

  const headerByScreen: Partial<Record<MobileScreen, { title?: string; subtitle?: string }>> = {
    menu: { title: "New Order" },
    order: { title: tableLabel, subtitle: orderSubtitle },
    payment: { title: `Pay ${tableLabel}` },
    receiptDetail: { title: "Receipt" },
    kitchen: { title: "Kitchen View" },
    receipts: { title: "Receipts" },
    more: { title: "More" },
  };
  const header = headerByScreen[screen];

  return (
    <div className={cn("lexibite-mobile-pos flex h-full min-h-0 flex-col bg-background", className)}>
      {screen !== "paymentSuccess" && (
        <MobilePosHeader
          outletName={data.outletName}
          title={header?.title}
          subtitle={header?.subtitle}
          showBack={DRILL_IN_SCREENS.has(screen)}
          onBack={() => backFrom(screen)}
          onMenu={() => setScreen("more")}
        />
      )}
      <MobileOfflineBanner status={data.offlineSync.status} />

      <div className="min-h-0 flex-1 overflow-hidden">
        {screen === "tables" && (
          <MobileTablesView data={data} onOpenOrder={openOrder} onStartOrder={startOrder} />
        )}
        {screen === "menu" && (
          <MobileMenuView data={data} onSelectItem={(item) => setPickerItem(item)} />
        )}
        {screen === "order" && (
          <MobileOrderView
            data={data}
            onAddItems={() => setScreen("menu")}
            onOpenPayment={() => setScreen("payment")}
          />
        )}
        {screen === "payment" && (
          <MobilePaymentView
            data={data}
            onRoomCharge={(amount) => setRoomChargeAmount(amount)}
            onRequestMobileMoney={(amount) => setMobileMoneyAmount(amount)}
            onPaid={() => setScreen("paymentSuccess")}
          />
        )}
        {screen === "paymentSuccess" && (
          <MobilePaymentSuccessView
            data={data}
            onNewOrder={() => {
              data.setReceipt(null);
              startWalkIn();
            }}
            onBackToTables={() => {
              data.setReceipt(null);
              setScreen("tables");
            }}
          />
        )}
        {screen === "receipts" && (
          <MobileReceiptsView
            data={data}
            onOpenReceipt={(orderId) => {
              setReceiptOrderId(orderId);
              setScreen("receiptDetail");
            }}
          />
        )}
        {screen === "receiptDetail" && receiptOrderId && (
          <MobileReceiptDetailView
            tenantId={data.tenantId}
            orderId={receiptOrderId}
            currencyFallback={data.currency}
          />
        )}
        {screen === "kitchen" && <MobileKitchenView tenantId={data.tenantId} />}
        {screen === "more" && (
          <MobileMoreView
            data={data}
            onNewOrder={() => {
              startWalkIn();
            }}
            onOpenTables={() => setScreen("tables")}
          />
        )}
      </div>

      {screen !== "paymentSuccess" && (
        <MobilePosBottomNav
          active={screen === "receiptDetail" ? "receipts" : screen}
          onSelect={setScreen}
          onNewOrder={startWalkIn}
        />
      )}

      <MobileItemSheet
        item={pickerItem}
        groups={(data.catalog.data?.modifierGroups ?? []) as any[]}
        currency={data.currency}
        seats={Number(data.orderRow?.guest_count ?? 0)}
        tenantId={data.tenantId}
        onClose={() => setPickerItem(null)}
        onAdd={(line) => {
          data.addCartLine(line);
          setScreen("order");
        }}
      />

      <PosRoomChargeDialog
        open={roomChargeAmount != null && Boolean(data.orderId)}
        tenantId={data.tenantId}
        orderId={data.orderId}
        amount={roomChargeAmount ?? 0}
        currency={data.currency}
        onClose={() => setRoomChargeAmount(null)}
        onPosted={(result: any) => {
          setRoomChargeAmount(null);
          data.setShareAmount(null);
          if (result?.receipt) data.setReceipt(result.receipt);
          data.refresh();
          setScreen("paymentSuccess");
        }}
      />

      <PosMobileMoneyDialog
        open={mobileMoneyAmount != null && Boolean(data.orderId)}
        tenantId={data.tenantId}
        orderId={data.orderId}
        amount={mobileMoneyAmount ?? 0}
        currency={data.currency}
        onClose={() => setMobileMoneyAmount(null)}
        onPosted={() => {
          setMobileMoneyAmount(null);
          data.setShareAmount(null);
          data.refresh();
          setScreen("paymentSuccess");
        }}
      />
    </div>
  );

  function backFrom(current: MobileScreen) {
    switch (current) {
      case "menu":
        setScreen("order");
        return;
      case "order":
        setScreen("tables");
        return;
      case "payment":
        setScreen("order");
        return;
      case "receiptDetail":
        setScreen("receipts");
        return;
      case "kitchen":
      case "receipts":
      case "more":
        setScreen("tables");
        return;
      default:
        setScreen("tables");
    }
  }
}
