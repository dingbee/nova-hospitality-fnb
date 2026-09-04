/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Mobile Money at the till.
 *
 * "Enter Lipa Namba -> Activate -> ON" is the Settings-side promise; this
 * is its POS-side mirror: the cashier taps Request Payment and sees only
 * operational language (never provider/API detail) while the Payment Core
 * drives the collection through its real state machine underneath. A
 * request being accepted is never shown as money received — only the
 * terminal PAID state does that.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Smartphone, XCircle } from "lucide-react";
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
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  cancelMobileMoneyCollectionFn,
  confirmMobileMoneyCollectionManuallyFn,
  getMobileMoneyStatusFn,
  refreshMobileMoneyCollectionStatusFn,
  requestMobileMoneyCollectionFn,
} from "../../payments/mobilemoney/mobilemoney.functions";
import { MM_NETWORK_LABELS } from "../../payments/mobilemoney/contracts";
import { money } from "./pos-types";

export function PosMobileMoneyDialog({
  open,
  tenantId,
  orderId,
  amount,
  currency,
  onClose,
  onPosted,
}: {
  open: boolean;
  tenantId?: string;
  orderId?: string | null;
  amount: number;
  currency: string;
  onClose: () => void;
  onPosted: (result: any) => void;
}) {
  const [phone, setPhone] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const qc = useQueryClient();
  const requestId = useMemo(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `mm-${Date.now()}-${Math.random()}`,
    // A new key per opening of the dialog: one interaction, one request.
    [open],
  );

  const requestFn = useServerFn(requestMobileMoneyCollectionFn);
  const statusFn = useServerFn(getMobileMoneyStatusFn);
  const refreshFn = useServerFn(refreshMobileMoneyCollectionStatusFn);
  const confirmFn = useServerFn(confirmMobileMoneyCollectionManuallyFn);
  const cancelFn = useServerFn(cancelMobileMoneyCollectionFn);

  useEffect(() => {
    if (!open) return;
    setPhone("");
    setCollectionId(null);
  }, [open]);

  const request = useAdminMutation({
    mutationFn: () =>
      requestFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          amount,
          customerPhone: phone || undefined,
          clientRequestId: requestId,
        },
      }),
    silentSuccess: true,
    onSuccess: (status: any) => setCollectionId(status.collectionId),
  });

  const status = useQuery({
    queryKey: ["restaurant.mobilemoney.status", tenantId, collectionId],
    queryFn: () => statusFn({ data: { tenantId: tenantId!, collectionId: collectionId! } }),
    enabled: Boolean(open && tenantId && collectionId),
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.state;
      return s && ["pending_customer", "processing", "created", "initiated"].includes(s)
        ? 3_000
        : false;
    },
  });

  // Connected mode: actively re-check with the provider each poll tick,
  // not just read our own last-known row — the webhook may not have
  // landed yet, and this is a legitimate operator-visible "check now".
  useEffect(() => {
    if (!collectionId || !tenantId) return;
    const s = (status.data as any)?.state;
    if (!s || !["pending_customer", "processing"].includes(s)) return;
    refreshFn({ data: { tenantId, collectionId } }).then(() =>
      qc.invalidateQueries({ queryKey: ["restaurant.mobilemoney.status", tenantId, collectionId] }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- polled by status.data changing, not a dependency array concern
  }, [status.dataUpdatedAt]);

  const confirm = useAdminMutation({
    mutationFn: () => confirmFn({ data: { tenantId: tenantId!, collectionId: collectionId! } }),
    successMessage: "Payment recorded",
  });

  const cancel = useAdminMutation({
    mutationFn: () => cancelFn({ data: { tenantId: tenantId!, collectionId: collectionId! } }),
    successMessage: "Payment request cancelled",
    onSuccess: () => onClose(),
  });

  const view = status.data as any;
  useEffect(() => {
    if (view?.state === "paid") onPosted({ posted: true, collectionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per terminal transition, not per render
  }, [view?.state]);

  const network = view?.network
    ? MM_NETWORK_LABELS[view.network as keyof typeof MM_NETWORK_LABELS]
    : null;
  const failed = view && ["failed", "expired"].includes(view.state);
  const manual = view?.requiresManualConfirmation;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-5" /> Mobile Money
          </DialogTitle>
          <DialogDescription>Amount {money(amount, currency)}</DialogDescription>
        </DialogHeader>

        {!collectionId ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Customer phone (optional)</Label>
              <Input
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="07XX XXX XXX"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className={`rounded-lg border p-4 text-center ${
                view?.state === "paid"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : failed
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-primary/40 bg-primary/5"
              }`}
            >
              {view?.state === "paid" ? (
                <CheckCircle2 className="mx-auto mb-2 size-8 text-emerald-600" />
              ) : failed ? (
                <XCircle className="mx-auto mb-2 size-8 text-destructive" />
              ) : null}
              <p className="text-lg font-semibold">
                {view?.operatorMessage ?? "Requesting payment…"}
              </p>
              {network && view?.merchantNumber && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {network} · {view.merchantNumber}
                </p>
              )}
              {view?.customerPhone && (
                <p className="text-xs text-muted-foreground">Customer {view.customerPhone}</p>
              )}
            </div>

            {manual && (
              <p className="text-xs text-muted-foreground">
                Confirm only once the payment has actually arrived at the merchant number.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {!collectionId ? (
            <>
              <Button variant="outline" className="min-h-12" onClick={onClose}>
                Cancel
              </Button>
              <Button
                className="min-h-12"
                disabled={request.isPending}
                onClick={() => request.mutate()}
              >
                {request.isPending ? "Requesting…" : "Request Payment"}
              </Button>
            </>
          ) : view?.state === "paid" ? (
            <Button className="min-h-12" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                className="min-h-12"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel request
              </Button>
              {manual && (
                <Button
                  className="min-h-12"
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate()}
                >
                  {confirm.isPending ? "Confirming…" : "Mark as received"}
                </Button>
              )}
              {failed && (
                <Button
                  className="min-h-12"
                  onClick={() => {
                    setCollectionId(null);
                  }}
                >
                  Try again
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
