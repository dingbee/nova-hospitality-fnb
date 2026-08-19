/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Delete } from "lucide-react";
import { POS_PAYMENT_METHODS, type PosPaymentMethod } from "../pos.contracts";
import { money } from "./pos-types";

const METHOD_LABELS: Record<PosPaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  mobile_money: "Mobile money",
  bank_transfer: "Bank transfer",
  room_charge: "Charge to room",
  voucher: "Voucher",
  comp: "Comp",
};

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

/**
 * A folio charge is not a tender taken at the counter — it is a receivable
 * posted to a guest's stay, and it needs its own governed flow.
 */
const PAD_METHODS = POS_PAYMENT_METHODS.filter((m) => m !== "room_charge");

/** Round-number notes a cashier is actually handed, above the amount due. */
function quickTenders(balance: number): number[] {
  const steps = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];
  const rounded = new Set<number>();
  for (const step of steps) {
    const up = Math.ceil(balance / step) * step;
    if (up > 0 && up >= balance) rounded.add(up);
  }
  return [...rounded].sort((a, b) => a - b).slice(0, 4);
}

/**
 * The payment pad: large targets, one decision at a time, and an explicit
 * confirmation before money is taken. Splitting is simply paying less than the
 * balance — the bill stays open until the server reports it settled.
 */
export function PosPaymentDialog({
  open,
  currency,
  total,
  paid,
  pending,
  suggestedAmount,
  onClose,
  onPay,
  canRoomCharge = false,
  onRoomCharge,
}: {
  open: boolean;
  currency: string;
  total: number;
  paid: number;
  pending: boolean;
  /** Pre-filled share when settling a split, e.g. one seat's portion. */
  suggestedAmount?: number | null;
  onClose: () => void;
  onPay: (input: { method: PosPaymentMethod; amount: number; tendered?: number; reference?: string }) => void;
  /** Whether this operator may post to a guest folio. */
  canRoomCharge?: boolean;
  /** Hands the amount to the governed room-charge flow. */
  onRoomCharge?: (amount: number) => void;
}) {
  const balance = Number(Math.max(0, total - paid).toFixed(2));
  const [method, setMethod] = useState<PosPaymentMethod>("cash");
  const [amount, setAmount] = useState<string>("");
  const [tendered, setTendered] = useState<string>("");
  const [reference, setReference] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    setAmount(suggestedAmount ? String(Number(suggestedAmount.toFixed(2))) : "");
    setTendered("");
    setReference("");
  }, [open, suggestedAmount]);

  const value = amount === "" ? balance : Number(amount);
  const tenderedValue = tendered === "" ? undefined : Number(tendered);
  const change = tenderedValue != null ? Math.max(0, Number((tenderedValue - value).toFixed(2))) : 0;
  const tenders = useMemo(() => quickTenders(value || balance), [value, balance]);
  const shortTender = method === "cash" && tenderedValue != null && tenderedValue + 0.001 < value;
  const valid = value > 0 && value <= balance + 0.001 && !shortTender;

  const press = (key: string) => {
    setConfirming(false);
    setAmount((prev) => {
      if (key === "back") return prev.slice(0, -1);
      if (key === "." && prev.includes(".")) return prev;
      return `${prev}${key}`;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>
            Balance due {money(balance, currency)} of {money(total, currency)}
            {paid > 0 ? ` · already paid ${money(paid, currency)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Charging now</p>
            <p className="text-3xl font-semibold tabular-nums">{money(value, currency)}</p>
            {value > 0 && value < balance && (
              <p className="text-xs text-muted-foreground">
                Split payment — {money(balance - value, currency)} stays on the bill.
              </p>
            )}
            {value > balance + 0.001 && (
              <p className="text-xs text-destructive">More than the balance due. Reduce the amount.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {PAD_METHODS.map((m) => (
              <Button
                key={m}
                type="button"
                variant={method === m ? "default" : "outline"}
                className="min-h-12"
                onClick={() => {
                  setMethod(m);
                  setConfirming(false);
                }}
              >
                {METHOD_LABELS[m]}
              </Button>
            ))}
          </div>

          {canRoomCharge && onRoomCharge && (
            <Button
              type="button"
              variant="secondary"
              className="min-h-12 w-full"
              disabled={!(value > 0 && value <= balance + 0.001)}
              onClick={() => onRoomCharge(Number(value.toFixed(2)))}
            >
              {METHOD_LABELS.room_charge} — {money(value, currency)}
            </Button>
          )}

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid grid-cols-3 gap-2">
              {PAD_KEYS.map((k) => (
                <Button
                  key={k}
                  type="button"
                  variant="outline"
                  className="min-h-14 text-lg"
                  onClick={() => press(k)}
                  aria-label={k === "back" ? "Delete last digit" : k}
                >
                  {k === "back" ? <Delete className="size-5" /> : k}
                </Button>
              ))}
              <Button
                type="button"
                variant="secondary"
                className="col-span-3 min-h-12"
                onClick={() => {
                  setAmount(String(balance));
                  setConfirming(false);
                }}
              >
                Full balance {money(balance, currency)}
              </Button>
            </div>

            <div className="space-y-3">
              {method === "cash" ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Cash tendered</Label>
                    <Input
                      inputMode="decimal"
                      value={tendered}
                      onChange={(e) => {
                        setTendered(e.target.value);
                        setConfirming(false);
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {tenders.map((t) => (
                      <Button
                        key={t}
                        type="button"
                        variant="outline"
                        className="min-h-12"
                        onClick={() => {
                          setTendered(String(t));
                          setConfirming(false);
                        }}
                      >
                        {money(t, currency)}
                      </Button>
                    ))}
                  </div>
                  <div className="rounded-lg border p-2 text-sm">
                    <span className="text-muted-foreground">Change due </span>
                    <span className="font-semibold tabular-nums">{money(change, currency)}</span>
                  </div>
                  {shortTender && (
                    <p className="text-xs text-destructive">Cash tendered is less than the amount being charged.</p>
                  )}
                </>
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Reference</Label>
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Auth / txn id"
                  />
                  <p className="text-xs text-muted-foreground">
                    Recorded on the receipt so the payment can be traced back to the provider.
                  </p>
                </div>
              )}
            </div>
          </div>

          {confirming && (
            <div className="rounded-lg border border-primary/50 bg-primary/5 p-3 text-sm">
              Confirm {METHOD_LABELS[method]} {money(value, currency)}
              {change > 0 ? ` · change ${money(change, currency)}` : ""}. This posts to the bill immediately.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-12" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="min-h-12"
            disabled={pending || !valid}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              onPay({
                method,
                amount: Number(value.toFixed(2)),
                tendered: tenderedValue,
                reference: reference || undefined,
              });
            }}
          >
            {pending ? "Processing…" : confirming ? `Confirm ${money(value, currency)}` : `Charge ${money(value, currency)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}