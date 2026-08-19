/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * The bill as the guest sees it, before any money moves.
 *
 * Splitting divides an existing total; it never restates it. Whichever split a
 * server chooses, the shares always add back up to the bill.
 */
import { useState } from "react";
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
import { LoadingState } from "@/components/os/LoadingState";
import { money } from "./pos-types";
import type { BillSplitMode } from "../bill.contracts";

const MODES: { id: BillSplitMode; label: string }[] = [
  { id: "none", label: "One bill" },
  { id: "seat", label: "By seat" },
  { id: "even", label: "Split evenly" },
];

export function PosBillDialog({
  open,
  bill,
  loading,
  currency,
  splitMode,
  ways,
  onSplitMode,
  onWays,
  onClose,
  onPresent,
  onPayShare,
  presenting,
}: {
  open: boolean;
  bill: any | null;
  loading: boolean;
  currency: string;
  splitMode: BillSplitMode;
  ways: number;
  onSplitMode: (m: BillSplitMode) => void;
  onWays: (n: number) => void;
  onClose: () => void;
  onPresent: () => void;
  onPayShare: (amount: number | null) => void;
  presenting: boolean;
}) {
  const [seat, setSeat] = useState<string | null>(null);
  const totals = bill?.totals;
  const shares = (bill?.split?.shares ?? []) as { key: string; label: string; amount: number }[];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bill {bill?.order?.order_number ?? ""}</DialogTitle>
          <DialogDescription>
            Review with the guest before taking payment. Figures are the ones the kitchen and pricing engine
            produced — nothing here is recalculated.
          </DialogDescription>
        </DialogHeader>

        {loading || !bill ? (
          <LoadingState />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1 font-mono text-xs">
              {(bill.lines ?? []).map((l: any) => (
                <div key={l.id} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    {Number(l.quantity)} × {l.description}
                    {l.seat_number ? (
                      <span className="block pl-4 text-muted-foreground">seat {l.seat_number}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(Number(l.line_total ?? 0), currency)}</span>
                </div>
              ))}
              {(bill.voidedLines ?? []).length > 0 && (
                <p className="pt-1 text-muted-foreground">
                  {(bill.voidedLines ?? []).length} voided line(s) excluded, kept on the audit trail.
                </p>
              )}
            </div>

            <div className="space-y-1 border-t pt-2 text-sm">
              <Row label="Subtotal" value={money(totals.subtotal, currency)} />
              {totals.discount > 0 && <Row label="Discount" value={`-${money(totals.discount, currency)}`} />}
              {totals.service > 0 && <Row label="Service charge" value={money(totals.service, currency)} />}
              <Row label="Tax" value={money(totals.tax, currency)} />
              <Row label="Total" value={money(totals.total, currency)} bold />
              {totals.paid > 0 && <Row label="Paid" value={money(totals.paid, currency)} />}
              {totals.refunded > 0 && <Row label="Refunded" value={money(totals.refunded, currency)} />}
              <Row label="Balance due" value={money(totals.balance, currency)} bold />
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <Button
                    key={m.id}
                    variant={splitMode === m.id ? "default" : "outline"}
                    className="min-h-11"
                    onClick={() => {
                      setSeat(null);
                      onSplitMode(m.id);
                    }}
                  >
                    {m.label}
                  </Button>
                ))}
                {splitMode === "even" && (
                  <div className="flex items-center gap-1">
                    <Button variant="outline" className="min-h-11" onClick={() => onWays(Math.max(2, ways - 1))}>
                      −
                    </Button>
                    <span className="min-w-8 text-center tabular-nums">{ways}</span>
                    <Button variant="outline" className="min-h-11" onClick={() => onWays(Math.min(24, ways + 1))}>
                      +
                    </Button>
                  </div>
                )}
              </div>

              {shares.length > 0 && (
                <div className="space-y-1">
                  {shares.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setSeat(seat === s.key ? null : s.key)}
                      className={`flex w-full items-center justify-between rounded border p-2 text-sm transition-colors ${
                        seat === s.key ? "border-primary bg-primary/5" : "hover:border-primary"
                      }`}
                    >
                      <span>{s.label}</span>
                      <span className="tabular-nums">{money(s.amount, currency)}</span>
                    </button>
                  ))}
                  {bill.split?.reconciles === false && (
                    <Badge variant="destructive">Shares do not reconcile with the bill total</Badge>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" className="min-h-12" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" className="min-h-12" disabled={presenting} onClick={onPresent}>
            {presenting ? "Printing…" : "Print & present"}
          </Button>
          <Button
            className="min-h-12"
            disabled={!bill}
            onClick={() => {
              const share = shares.find((s) => s.key === seat);
              onPayShare(share ? share.amount : null);
            }}
          >
            {seat ? "Pay this share" : "Take payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}