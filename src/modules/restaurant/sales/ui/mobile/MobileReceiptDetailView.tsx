/* eslint-disable @typescript-eslint/no-explicit-any -- receipt snapshot is untyped at this boundary, matching PosReceiptDialog. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { ReceiptDeliveryPanel } from "@/modules/restaurant/receipts/ui/ReceiptDeliveryPanel";
import { posReceiptFn } from "../../pos.functions";
import { money } from "../pos-types";
import { LexiBiteLoading } from "./LexiBiteLoading";

/** Screen 6 detail — the frozen receipt snapshot (posReceiptFn's read path), a mobile-native layout of what PosReceiptDialog already shows. */
export function MobileReceiptDetailView({
  tenantId,
  orderId,
  currencyFallback,
}: {
  tenantId: string;
  orderId: string;
  currencyFallback: string;
}) {
  const fn = useServerFn(posReceiptFn);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["restaurant.pos.receipt", tenantId, orderId],
    queryFn: () => fn({ data: { tenantId, orderId, reprint: false } }) as any,
    enabled: Boolean(tenantId && orderId),
  });

  const reprint = useAdminMutation({
    mutationFn: () => fn({ data: { tenantId, orderId, reprint: true } }),
    successMessage: "Reprinted",
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["restaurant.pos.receipt", tenantId, orderId] }),
  });

  if (q.isLoading) return <LexiBiteLoading label="Loading receipt…" />;
  const receipt = q.data as any;
  if (!receipt) return null;

  const snapshot = receipt.snapshot ?? {};
  const currency = receipt.currency ?? currencyFallback;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-3">
        <div
          className="rounded-2xl border p-4 text-center"
          style={{
            borderColor: "color-mix(in oklab, var(--lb-green) 35%, transparent)",
            background: "color-mix(in oklab, var(--lb-green) 8%, white)",
          }}
        >
          <p className="text-lg font-bold">{money(Number(receipt.total ?? 0), currency)}</p>
          <p className="text-xs text-muted-foreground">
            Order {snapshot.order?.number} ·{" "}
            {receipt.reprint_count > 0 ? `reprint ×${receipt.reprint_count}` : "original"}
          </p>
        </div>

        <div className="space-y-2 rounded-xl border bg-card p-3 font-mono text-xs">
          {(snapshot.lines ?? []).map((l: any) => (
            <div key={l.id} className="flex justify-between gap-3">
              <span className="min-w-0">
                {Number(l.quantity)} × {l.description}
              </span>
              <span className="shrink-0 tabular-nums">
                {money(Number(l.line_total ?? 0), currency)}
              </span>
            </div>
          ))}
          <div className="space-y-1 border-t pt-2">
            <Row label="Subtotal" value={money(Number(receipt.subtotal ?? 0), currency)} />
            <Row label="Tax" value={money(Number(receipt.tax_total ?? 0), currency)} />
            <Row label="Total" value={money(Number(receipt.total ?? 0), currency)} bold />
          </div>
          <div className="space-y-1 border-t pt-2">
            {(snapshot.payments ?? []).map((p: any) => (
              <Row
                key={p.id}
                label={String(p.method).replace(/_/g, " ")}
                value={money(Number(p.amount ?? 0), currency)}
              />
            ))}
          </div>
        </div>

        <ReceiptDeliveryPanel
          tenantId={tenantId}
          receiptId={receipt.id}
          orderId={receipt.order_id}
          receiptNumber={receipt.receipt_number}
          total={money(Number(receipt.total ?? 0), currency)}
        />
      </div>

      <div className="shrink-0 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button
          variant="outline"
          className="min-h-13 w-full rounded-xl"
          disabled={reprint.isPending}
          onClick={() => reprint.mutate(undefined as never)}
        >
          {reprint.isPending ? "Reprinting…" : "Reprint"}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={bold ? "flex justify-between font-semibold" : "flex justify-between"}>
      <span className="capitalize">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
