/* eslint-disable @typescript-eslint/no-explicit-any -- bill/order rows are untyped at this boundary, matching PosPaymentDialog/PosBillDialog. */
import { useEffect, useMemo, useState } from "react";
import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { BillSplitMode } from "../../bill.contracts";
import type { PosPaymentMethod } from "../../pos.contracts";
import { money } from "../pos-types";
import { quickTenders } from "../pos-money";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";
import { LexiBiteLoading } from "./LexiBiteLoading";

const METHOD_LABELS: Record<PosPaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  mobile_money: "Mobile Money",
  bank_transfer: "Bank / Other",
  room_charge: "Charge to room",
  voucher: "Voucher",
  comp: "Comp",
};

const MODES: { id: BillSplitMode; label: string }[] = [
  { id: "none", label: "Full Payment" },
  { id: "seat", label: "By Item" },
  { id: "even", label: "Split Bill" },
];

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

type Step = "amount" | "method" | "cash" | "reference";

/**
 * Screens 4 + 13 — payment. Full Payment / Split Bill / By Item picks the
 * amount (identical split math to PosBillDialog's bill query); Cash gets a
 * dedicated numeric-keypad screen (section 13); every other method gets a
 * simple confirm step. All of it calls the same `takePosPaymentFn` mutation
 * PosPaymentDialog does — nothing here recomputes money.
 */
export function MobilePaymentView({
  data,
  onRoomCharge,
  onRequestMobileMoney,
  onPaid,
}: {
  data: LexiBiteMobilePosData;
  onRoomCharge: (amount: number) => void;
  onRequestMobileMoney: (amount: number) => void;
  onPaid: () => void;
}) {
  const { bill, currency, orderRow } = data;
  const totals = (bill.data as any)?.totals;
  const shares = ((bill.data as any)?.split?.shares ?? []) as {
    key: string;
    label: string;
    amount: number;
  }[];
  const total = Number(orderRow?.total ?? 0);
  const paid = Number(orderRow?.paid_total ?? 0);
  const balance = Number(Math.max(0, total - paid).toFixed(2));

  const [step, setStep] = useState<Step>("amount");
  const [selectedShareKey, setSelectedShareKey] = useState<string | null>(null);
  const [method, setMethod] = useState<PosPaymentMethod>("cash");
  const [amountInput, setAmountInput] = useState("");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [showMoreMethods, setShowMoreMethods] = useState(false);

  // Fresh every time this screen is entered — this component remounts on
  // each navigation into "payment" (its parent conditionally renders it),
  // but the split-mode/share-amount live in the shared data hook and would
  // otherwise leak in stale from a previous, uncompleted payment attempt.
  useEffect(() => {
    data.setSplitMode("none");
    data.setShareAmount(null);
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (data.shareAmount != null) setAmountInput(String(Number(data.shareAmount.toFixed(2))));
  }, [data.shareAmount]);

  const chargeAmount = amountInput === "" ? (data.shareAmount ?? balance) : Number(amountInput);
  const tenderedValue = tendered === "" ? undefined : Number(tendered);
  const change =
    tenderedValue != null ? Math.max(0, Number((tenderedValue - chargeAmount).toFixed(2))) : 0;
  const tenders = useMemo(() => quickTenders(chargeAmount || balance), [chargeAmount, balance]);
  const shortTender = method === "cash" && tenderedValue != null && tenderedValue + 0.001 < chargeAmount;
  const valid = chargeAmount > 0 && chargeAmount <= balance + 0.001 && !shortTender;

  const pay = data.mutations.pay;

  const submit = () => {
    pay.mutate(
      {
        method,
        amount: Number(chargeAmount.toFixed(2)),
        tendered: tenderedValue,
        reference: reference || undefined,
      },
      { onSuccess: onPaid },
    );
  };

  if (bill.isLoading || !totals) return <LexiBiteLoading label="Loading bill…" />;

  if (step === "amount") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
          <div className="rounded-2xl border bg-card p-5 text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Balance due
            </p>
            <p className="mt-1 text-4xl font-extrabold tabular-nums">{money(balance, currency)}</p>
            <p className="mt-1 text-sm text-muted-foreground">of {money(total, currency)} total</p>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setSelectedShareKey(null);
                  data.setShareAmount(null);
                  data.setSplitMode(m.id);
                  setAmountInput("");
                }}
                className={cn(
                  "min-h-12 rounded-xl border px-2 text-sm font-semibold transition-colors",
                  data.splitMode === m.id ? "border-transparent text-white" : "border-border bg-card",
                )}
                style={data.splitMode === m.id ? { background: "var(--lb-green)" } : undefined}
              >
                {m.label}
              </button>
            ))}
          </div>

          {data.splitMode === "even" && (
            <div className="mt-3 flex items-center justify-center gap-3">
              <Button
                variant="outline"
                className="size-11 rounded-full p-0"
                onClick={() => data.setWays(Math.max(2, data.ways - 1))}
              >
                −
              </Button>
              <span className="min-w-10 text-center text-lg font-semibold tabular-nums">
                {data.ways} ways
              </span>
              <Button
                variant="outline"
                className="size-11 rounded-full p-0"
                onClick={() => data.setWays(Math.min(24, data.ways + 1))}
              >
                +
              </Button>
            </div>
          )}

          {data.splitMode !== "none" && shares.length > 0 && (
            <div className="mt-4 space-y-2">
              {shares.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => {
                    setSelectedShareKey(s.key);
                    data.setShareAmount(s.amount);
                  }}
                  className={cn(
                    "flex min-h-14 w-full items-center justify-between rounded-xl border px-4 text-left",
                    selectedShareKey === s.key ? "border-2" : "border-border",
                  )}
                  style={selectedShareKey === s.key ? { borderColor: "var(--lb-green)" } : undefined}
                >
                  <span className="font-medium">{s.label}</span>
                  <span className="font-semibold tabular-nums">{money(s.amount, currency)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button
            className="min-h-14 w-full rounded-xl text-base font-bold text-white"
            style={{ background: "var(--lb-green)" }}
            disabled={data.splitMode !== "none" && shares.length > 0 && !selectedShareKey}
            onClick={() => {
              if (data.splitMode === "none") {
                data.setShareAmount(null);
                setAmountInput("");
              }
              setStep("method");
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (step === "method") {
    const primary: PosPaymentMethod[] = ["cash", "card", "mobile_money", "bank_transfer"];
    const more: PosPaymentMethod[] = ["voucher", "comp"];
    const selectMethod = (m: PosPaymentMethod) => {
      setMethod(m);
      setTendered("");
      setReference("");
      if (m === "mobile_money" && data.mobileMoneyActive) {
        onRequestMobileMoney(chargeAmount);
        return;
      }
      setStep(m === "cash" ? "cash" : "reference");
    };
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
          <p className="text-center text-2xl font-extrabold tabular-nums">
            {money(chargeAmount, currency)}
          </p>
          <p className="mb-4 text-center text-xs text-muted-foreground">Choose a payment method</p>

          <div className="space-y-2.5">
            {primary.map((m) => (
              <MethodRow key={m} label={METHOD_LABELS[m]} onClick={() => selectMethod(m)} />
            ))}
            {data.canRoomCharge && (
              <MethodRow label={METHOD_LABELS.room_charge} onClick={() => onRoomCharge(chargeAmount)} />
            )}
          </div>

          {!showMoreMethods ? (
            <button
              type="button"
              className="mt-3 min-h-11 w-full text-center text-sm font-medium text-muted-foreground underline"
              onClick={() => setShowMoreMethods(true)}
            >
              More methods
            </button>
          ) : (
            <div className="mt-2.5 space-y-2.5">
              {more.map((m) => (
                <MethodRow key={m} label={METHOD_LABELS[m]} onClick={() => selectMethod(m)} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === "cash") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
          <div className="rounded-2xl border bg-card p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Charging now
            </p>
            <p className="mt-1 text-3xl font-extrabold tabular-nums">{money(chargeAmount, currency)}</p>
          </div>

          <div className="mt-4 space-y-1">
            <Label className="text-xs text-muted-foreground">Cash tendered</Label>
            <Input
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              className="h-14 text-center text-xl font-semibold"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {tenders.map((t) => (
              <Button key={t} variant="outline" className="min-h-12 rounded-xl" onClick={() => setTendered(String(t))}>
                {money(t, currency)}
              </Button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {PAD_KEYS.map((k) => (
              <Button
                key={k}
                type="button"
                variant="outline"
                className="min-h-14 rounded-xl text-lg"
                onClick={() =>
                  setTendered((prev) => {
                    if (k === "back") return prev.slice(0, -1);
                    if (k === "." && prev.includes(".")) return prev;
                    return `${prev}${k}`;
                  })
                }
                aria-label={k === "back" ? "Delete last digit" : k}
              >
                {k === "back" ? <Delete className="size-5" /> : k}
              </Button>
            ))}
          </div>

          <div className="mt-3 rounded-xl border p-3 text-center">
            <span className="text-sm text-muted-foreground">Change due </span>
            <span className="text-lg font-bold tabular-nums">{money(change, currency)}</span>
          </div>
          {shortTender && (
            <p className="mt-2 text-center text-xs text-destructive">
              Cash tendered is less than the amount being charged.
            </p>
          )}
        </div>

        <div className="shrink-0 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button
            className="min-h-14 w-full rounded-xl text-base font-bold text-white"
            style={{ background: "var(--lb-green)" }}
            disabled={pay.isPending || !valid}
            onClick={submit}
          >
            {pay.isPending ? "Processing…" : `Process payment · ${money(chargeAmount, currency)}`}
          </Button>
        </div>
      </div>
    );
  }

  // step === "reference"
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
        <div className="rounded-2xl border bg-card p-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {METHOD_LABELS[method]}
          </p>
          <p className="mt-1 text-3xl font-extrabold tabular-nums">{money(chargeAmount, currency)}</p>
        </div>
        <div className="mt-4 space-y-1">
          <Label className="text-xs text-muted-foreground">Reference (optional)</Label>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Auth / txn id"
            className="h-12"
          />
          <p className="text-xs text-muted-foreground">
            Recorded on the receipt so the payment can be traced back to the provider.
          </p>
        </div>
      </div>
      <div className="shrink-0 border-t bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button
          className="min-h-14 w-full rounded-xl text-base font-bold text-white"
          style={{ background: "var(--lb-green)" }}
          disabled={pay.isPending || !valid}
          onClick={submit}
        >
          {pay.isPending ? "Processing…" : `Process payment · ${money(chargeAmount, currency)}`}
        </Button>
      </div>
    </div>
  );
}

function MethodRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 w-full items-center justify-between rounded-xl border bg-card px-4 text-left text-base font-semibold active:bg-muted"
    >
      {label}
      <span className="text-muted-foreground">›</span>
    </button>
  );
}
