/* eslint-disable @typescript-eslint/no-explicit-any -- bill rows are server-shaped at this UI boundary. */
import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/os/LoadingState";
import { money } from "./pos-types";
import type { BillSplitMode, SaveBillSplitInput } from "../bill.contracts";

const MODES: { id: BillSplitMode; label: string }[] = [
  { id: "none", label: "One bill" },
  { id: "even", label: "Evenly" },
  { id: "items", label: "By item" },
  { id: "seat", label: "By seat" },
  { id: "amount", label: "By amount" },
  { id: "percentage", label: "By %" },
];

type Share = { key: string; label: string; amount: number; splitBillId?: string; splitNo?: number; allocation?: any[] };

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
  onPayShare: (value: { amount: number | null; splitBillId?: string; splitNo?: number; splitPlan?: SaveBillSplitInput }) => void;
  presenting: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<number[]>([0, 0]);
  const [percentages, setPercentages] = useState<number[]>([50, 50]);
  const [itemQty, setItemQty] = useState<Record<string, number[]>>({});

  const totals = bill?.totals;
  const lines = (bill?.lines ?? []) as any[];
  const persisted = (bill?.splitBills ?? []) as any[];
  const balance = Number(totals?.balance ?? 0);

  useEffect(() => {
    const per = balance / Math.max(2, ways);
    setAmounts(Array.from({ length: ways }, () => Number(per.toFixed(2))));
    setPercentages(Array.from({ length: ways }, () => Number((100 / Math.max(2, ways)).toFixed(2))));
  }, [balance, ways]);

  useEffect(() => {
    const next: Record<string, number[]> = {};
    lines.forEach((line, index) => {
      const q = Number(line.quantity ?? 0);
      const arr = Array.from({ length: ways }, () => 0);
      arr[index % ways] = q;
      next[line.id] = arr;
    });
    setItemQty(next);
  }, [lines.map((l) => l.id).join("|"), ways]);

  const localShares = useMemo<Share[]>(() => {
    if (!bill || splitMode === "none") return [];
    if (splitMode === "even") {
      const per = Number((balance / ways).toFixed(2));
      const shares = Array.from({ length: ways }, (_, i) => ({ key: `new-${i + 1}`, label: `Bill ${i + 1}`, amount: per, splitNo: i + 1 }));
      const drift = Number((balance - shares.reduce((s, x) => s + x.amount, 0)).toFixed(2));
      if (shares[0]) shares[0].amount = Number((shares[0].amount + drift).toFixed(2));
      return shares;
    }
    if (splitMode === "amount") {
      return amounts.map((amount, i) => ({ key: `new-${i + 1}`, label: `Bill ${i + 1}`, amount }));
    }
    if (splitMode === "percentage") {
      return percentages.map((pct, i) => ({
        key: `new-${i + 1}`,
        label: `Bill ${i + 1} · ${pct}%`,
        amount: Number((balance * pct / 100).toFixed(2)),
        splitNo: i + 1,
      }));
    }
    if (splitMode === "items") {
      return Array.from({ length: ways }, (_, i) => {
        let amount = 0;
        const allocation: any[] = [];
        for (const line of lines) {
          const q = Number(itemQty[line.id]?.[i] ?? 0);
          if (q > 0) {
            amount += (Number(line.line_total ?? 0) / Math.max(1, Number(line.quantity ?? 1))) * q;
            allocation.push({ lineId: line.id, splitNo: i + 1, quantity: q });
          }
        }
        return { key: `new-${i + 1}`, label: `Bill ${i + 1}`, amount: Number(amount.toFixed(2)), splitNo: i + 1, allocation };
      });
    }
    return persisted.map((s) => ({
      key: s.id,
      label: s.label,
      amount: Number(s.balance ?? s.amount ?? 0),
      splitBillId: s.id,
      splitNo: Number(s.split_no ?? 0),
      allocation: s.allocation ?? [],
    }));
  }, [bill, splitMode, ways, balance, amounts, percentages, itemQty, lines, persisted]);

  const shareTotal = localShares.reduce((sum, s) => sum + s.amount, 0);
  const amountValid = splitMode !== "amount" || Math.abs(shareTotal - balance) < 0.01;
  const percentageValid =
    splitMode !== "percentage" ||
    Math.abs(percentages.reduce((a, b) => a + b, 0) - 100) < 0.01;
  const itemValid =
    splitMode !== "items" ||
    lines.every((line) => {
      const assigned = (itemQty[line.id] ?? []).reduce((a, b) => a + b, 0);
      return Math.abs(assigned - Number(line.quantity ?? 0)) < 0.0001;
    });

  const splitPlan = (): SaveBillSplitInput | undefined => {
    if (splitMode === "none") return undefined;
    if (splitMode === "even") return { tenantId: bill.order.tenant_id, orderId: bill.order.id, mode: "even", ways };
    if (splitMode === "seat") return { tenantId: bill.order.tenant_id, orderId: bill.order.id, mode: "seat" };
    if (splitMode === "amount") return { tenantId: bill.order.tenant_id, orderId: bill.order.id, mode: "amount", amounts };
    if (splitMode === "percentage") return { tenantId: bill.order.tenant_id, orderId: bill.order.id, mode: "percentage", percentages };
    return {
      tenantId: bill.order.tenant_id,
      orderId: bill.order.id,
      mode: "items",
      allocations: Object.entries(itemQty).flatMap(([lineId, quantities]) =>
        quantities.map((quantity, i) => ({ lineId, splitNo: i + 1, quantity })).filter((x) => x.quantity > 0),
      ),
    };
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bill {bill?.order?.order_number ?? ""}</DialogTitle>
          <DialogDescription>
            Split the outstanding balance into child bills. The parent order remains the commercial source of truth.
          </DialogDescription>
        </DialogHeader>

        {loading || !bill ? <LoadingState /> : (
          <div className="space-y-4">
            <div className="space-y-1 font-mono text-xs">
              {lines.map((l: any) => (
                <div key={l.id} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    {Number(l.quantity)} × {l.description}
                    {l.seat_number ? <span className="block pl-4 text-muted-foreground">seat {l.seat_number}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(Number(l.line_total ?? 0), currency)}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1 border-t pt-2 text-sm">
              <Row label="Subtotal" value={money(totals.subtotal, currency)} />
              {totals.discount > 0 && <Row label="Discount" value={`-${money(totals.discount, currency)}`} />}
              {totals.service > 0 && <Row label="Service charge" value={money(totals.service, currency)} />}
              <Row label="Tax" value={money(totals.tax, currency)} />
              <Row label="Total" value={money(totals.total, currency)} bold />
              {totals.paid > 0 && <Row label="Paid" value={money(totals.paid, currency)} />}
              <Row label="Balance due" value={money(balance, currency)} bold />
            </div>

            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <Button key={m.id} variant={splitMode === m.id ? "default" : "outline"} className="min-h-11" onClick={() => {
                  setSelected(null);
                  onSplitMode(m.id);
                }}>
                  {m.label}
                </Button>
              ))}
            </div>

            {splitMode !== "none" && splitMode !== "seat" && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Bills</span>
                <Button variant="outline" className="min-h-10" onClick={() => onWays(Math.max(2, ways - 1))}>−</Button>
                <span className="min-w-8 text-center tabular-nums">{ways}</span>
                <Button variant="outline" className="min-h-10" onClick={() => onWays(Math.min(24, ways + 1))}>+</Button>
              </div>
            )}

            {splitMode === "amount" && (
              <div className="grid gap-2 sm:grid-cols-2">
                {amounts.map((value, i) => (
                  <label key={i} className="rounded border p-2 text-sm">
                    Bill {i + 1}
                    <Input type="number" min="0" step="0.01" value={value} onChange={(e) => {
                      const next = [...amounts]; next[i] = Number(e.target.value || 0); setAmounts(next);
                    }} />
                  </label>
                ))}
              </div>
            )}

            {splitMode === "percentage" && (
              <div className="grid gap-2 sm:grid-cols-2">
                {percentages.map((value, i) => (
                  <label key={i} className="rounded border p-2 text-sm">
                    Bill {i + 1} %
                    <Input type="number" min="0" max="100" step="0.01" value={value} onChange={(e) => {
                      const next = [...percentages]; next[i] = Number(e.target.value || 0); setPercentages(next);
                    }} />
                  </label>
                ))}
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Total percentage: {percentages.reduce((a, b) => a + b, 0).toFixed(2)}%
                </p>
              </div>
            )}

            {splitMode === "items" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Allocate every unit. A line with quantity 2 can be divided 1 + 1 between bills.
                </p>
                {lines.map((line: any) => (
                  <div key={line.id} className="rounded border p-2">
                    <div className="mb-2 flex justify-between gap-2 text-sm font-medium">
                      <span>{line.description}</span>
                      <span>{Number(line.quantity)} ×</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Array.from({ length: ways }, (_, i) => (
                        <label key={i} className="text-xs text-muted-foreground">
                          Bill {i + 1}
                          <Input
                            type="number"
                            min="0"
                            max={Number(line.quantity)}
                            step="1"
                            value={itemQty[line.id]?.[i] ?? 0}
                            onChange={(e) => {
                              const next = [...(itemQty[line.id] ?? Array.from({ length: ways }, () => 0))];
                              next[i] = Math.max(0, Number(e.target.value || 0));
                              setItemQty((prev) => ({ ...prev, [line.id]: next }));
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Allocated: {(itemQty[line.id] ?? []).reduce((a, b) => a + b, 0)} / {Number(line.quantity)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {splitMode === "seat" && (
              <p className="text-xs text-muted-foreground">
                Each seat becomes its own bill. Items without a seat remain together as “Shared items”.
              </p>
            )}

            {localShares.length > 0 && (
              <div className="space-y-1">
                {localShares.map((share) => (
                  <button
                    key={share.key}
                    type="button"
                    onClick={() => setSelected(selected === share.key ? null : share.key)}
                    className={`flex w-full items-center justify-between rounded border p-3 text-sm transition-colors ${selected === share.key ? "border-primary bg-primary/5" : "hover:border-primary"}`}
                  >
                    <span>{share.label}</span>
                    <span className="tabular-nums">{money(share.amount, currency)}</span>
                  </button>
                ))}
                {splitMode === "amount" && !amountValid && <Badge variant="destructive">Amounts must equal the outstanding balance.</Badge>}
                {splitMode === "percentage" && !percentageValid && <Badge variant="destructive">Percentages must total 100%.</Badge>}
                {splitMode === "items" && !itemValid && <Badge variant="destructive">Allocate every item quantity before paying.</Badge>}
                {splitMode !== "items" && splitMode !== "percentage" && Math.abs(shareTotal - balance) >= 0.01 && (
                  <Badge variant="destructive">Shares do not reconcile with the outstanding balance.</Badge>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" className="min-h-12" onClick={onClose}>Close</Button>
          <Button variant="secondary" className="min-h-12" disabled={presenting} onClick={onPresent}>
            {presenting ? "Printing…" : "Print & present"}
          </Button>
          <Button
            className="min-h-12"
            disabled={!bill || (splitMode !== "none" && !selected) || (splitMode === "amount" && !amountValid) || (splitMode === "percentage" && !percentageValid) || (splitMode === "items" && !itemValid)}
            onClick={() => {
              const share = localShares.find((s) => s.key === selected);
              onPayShare({
                amount: share ? share.amount : null,
                splitBillId: share?.splitBillId,
                splitNo: share?.splitNo,
                splitPlan: splitPlan(),
              });
            }}
          >
            {selected ? "Pay this bill" : "Take payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}