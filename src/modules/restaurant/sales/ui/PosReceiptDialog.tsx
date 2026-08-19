/* eslint-disable @typescript-eslint/no-explicit-any -- receipt snapshot is untyped at this boundary. */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { money } from "./pos-types";
import { ReceiptDeliveryPanel } from "@/modules/restaurant/receipts/ui/ReceiptDeliveryPanel";

/**
 * The frozen receipt snapshot, plus the one remaining service act: getting it
 * into the guest's hands. Nothing here is recomputed; delivery is recorded
 * against the receipt rather than changing it.
 */
export function PosReceiptDialog({
  receipt,
  onClose,
  onReprint,
  tenantId,
}: {
  receipt: any | null;
  onClose: () => void;
  onReprint?: () => void;
  tenantId?: string;
}) {
  if (!receipt) return null;
  const snapshot = receipt.snapshot ?? {};
  const currency = receipt.currency ?? "TZS";
  const change = Number(snapshot.payments?.reduce?.((s: number, p: any) => s + Number(p.change_due ?? 0), 0) ?? 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Receipt {receipt.receipt_number}</DialogTitle>
          <DialogDescription>
            Order {snapshot.order?.number} ·{" "}
            {receipt.reprint_count > 0 ? `reprint ×${receipt.reprint_count}` : "original"}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
          <p className="font-semibold">Paid in full · {money(Number(receipt.total ?? 0), currency)}</p>
          {change > 0 && <p className="text-xs">Change given {money(change, currency)}</p>}
          {receipt.delivered_at ? (
            <Badge variant="secondary" className="mt-1">
              Delivered by {receipt.delivery_channel}
              {receipt.delivered_to ? ` · ${receipt.delivered_to}` : ""}
            </Badge>
          ) : (
            <p className="text-xs text-muted-foreground">Record how the guest receives this receipt.</p>
          )}
        </div>

        <div className="space-y-3 font-mono text-xs">
          {(snapshot.lines ?? []).map((l: any) => (
            <div key={l.id} className="flex justify-between gap-3">
              <span className="min-w-0">
                {Number(l.quantity)} × {l.description}
                {(l.modifiers ?? []).length > 0 && (
                  <span className="block pl-4 text-muted-foreground">
                    {(l.modifiers ?? []).map((m: any) => m.name).join(", ")}
                  </span>
                )}
                {l.seat_number ? <span className="block pl-4 text-muted-foreground">seat {l.seat_number}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums">{money(Number(l.line_total ?? 0), currency)}</span>
            </div>
          ))}

          <div className="space-y-1 border-t pt-2">
            <Row label="Subtotal" value={money(Number(receipt.subtotal ?? 0), currency)} />
            {Number(receipt.discount_total ?? 0) > 0 && (
              <Row label="Discount" value={`-${money(Number(receipt.discount_total), currency)}`} />
            )}
            {Number(receipt.service_charge ?? 0) > 0 && (
              <Row label="Service" value={money(Number(receipt.service_charge), currency)} />
            )}
            <Row label="Tax" value={money(Number(receipt.tax_total ?? 0), currency)} />
            <Row label="Total" value={money(Number(receipt.total ?? 0), currency)} bold />
          </div>

          <div className="space-y-1 border-t pt-2">
            {(snapshot.payments ?? []).map((p: any) => (
              <Row key={p.id} label={String(p.method).replace(/_/g, " ")} value={money(Number(p.amount ?? 0), currency)} />
            ))}
          </div>
        </div>

        {tenantId && (
          <ReceiptDeliveryPanel
            tenantId={tenantId}
            receiptId={receipt.id}
            orderId={receipt.order_id}
            receiptNumber={receipt.receipt_number}
            total={money(Number(receipt.total ?? 0), currency)}
          />
        )}

        <DialogFooter>
          {onReprint && (
            <Button variant="outline" className="min-h-11" onClick={onReprint}>
              Reprint
            </Button>
          )}
          <Button className="min-h-11" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="capitalize">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}