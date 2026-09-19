/* eslint-disable @typescript-eslint/no-explicit-any -- receipt snapshot is untyped at this boundary, matching PosReceiptDialog. */
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReceiptDeliveryPanel } from "@/modules/restaurant/receipts/ui/ReceiptDeliveryPanel";
import { money } from "../pos-types";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";

/**
 * Screen 5 — payment success. Reads the real receipt the payment mutation
 * returned (data.receipt, set in useLexiBiteMobilePos's `pay.onSuccess`) —
 * never a fabricated confirmation.
 */
export function MobilePaymentSuccessView({
  data,
  onNewOrder,
  onBackToTables,
}: {
  data: LexiBiteMobilePosData;
  onNewOrder: () => void;
  onBackToTables: () => void;
}) {
  const [sending, setSending] = useState(false);
  const receipt = data.receipt as any;
  const amount = Number(receipt?.total ?? data.orderRow?.total ?? 0);
  const tableLabel = data.activeTable ? `Table ${data.activeTable.code}` : "Walk-in / bar tab";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-8">
        <div className="flex flex-col items-center text-center">
          <span
            className="flex size-20 items-center justify-center rounded-full"
            style={{ background: "color-mix(in oklab, var(--lb-green) 14%, white)" }}
          >
            <CheckCircle2 className="size-11" style={{ color: "var(--lb-green)" }} />
          </span>
          <h2 className="mt-4 text-xl font-bold">Payment Successful</h2>
          <p className="mt-3 text-4xl font-extrabold tabular-nums">{money(amount, data.currency)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tableLabel}</p>
          {receipt?.receipt_number && (
            <p className="mt-1 text-xs text-muted-foreground">Receipt {receipt.receipt_number}</p>
          )}
        </div>

        <div className="mt-8 space-y-2.5">
          <Button
            variant="outline"
            className="min-h-13 w-full rounded-xl"
            onClick={() => typeof window !== "undefined" && window.print()}
          >
            Print Receipt
          </Button>
          <Button
            variant="outline"
            className="min-h-13 w-full rounded-xl"
            onClick={() => setSending((v) => !v)}
          >
            Send Receipt
          </Button>
          {sending && receipt && data.tenantId && (
            <ReceiptDeliveryPanel
              tenantId={data.tenantId}
              receiptId={receipt.id}
              orderId={receipt.order_id}
              receiptNumber={receipt.receipt_number}
              total={money(amount, data.currency)}
            />
          )}
        </div>
      </div>

      <div className="shrink-0 grid grid-cols-2 gap-2.5 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button variant="secondary" className="min-h-14 rounded-xl" onClick={onBackToTables}>
          Back to Tables
        </Button>
        <Button
          className="min-h-14 rounded-xl text-white"
          style={{ background: "var(--lb-green)" }}
          onClick={onNewOrder}
        >
          New Order
        </Button>
      </div>
    </div>
  );
}
