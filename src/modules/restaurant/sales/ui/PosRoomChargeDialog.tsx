/* eslint-disable @typescript-eslint/no-explicit-any -- server rows are untyped at this boundary. */
/**
 * Charge to room.
 *
 * Deliberately slower than the cash pad: the operator must find the stay, read
 * the guest and room back, and confirm. A refusal from the property system is
 * shown as a refusal — the bill stays open and another tender must be taken.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BedDouble, Search, ShieldAlert } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { commitRoomChargeFn, quoteRoomChargeFn, searchRoomChargeTargetsFn } from "../roomcharge.functions";
import { money } from "./pos-types";

export function PosRoomChargeDialog({
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
  const [term, setTerm] = useState("");
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useMemo(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `rc-${Date.now()}-${Math.random()}`,
    // A new key per opening of the dialog: one interaction, one posting.
    [open],
  );

  const searchFn = useServerFn(searchRoomChargeTargetsFn);
  const quoteFn = useServerFn(quoteRoomChargeFn);
  const commitFn = useServerFn(commitRoomChargeFn);

  useEffect(() => {
    if (!open) return;
    setTerm("");
    setBookingId(null);
    setFailure(null);
  }, [open]);

  const stays = useQuery({
    queryKey: ["restaurant.roomcharge.stays", tenantId, term],
    queryFn: () => searchFn({ data: { tenantId: tenantId!, query: term || undefined } }),
    enabled: Boolean(open && tenantId),
    staleTime: 15_000,
  });

  const quote = useQuery({
    queryKey: ["restaurant.roomcharge.quote", tenantId, orderId, bookingId, amount],
    queryFn: () => quoteFn({ data: { tenantId: tenantId!, orderId: orderId!, bookingId: bookingId!, amount } }),
    enabled: Boolean(open && tenantId && orderId && bookingId && amount > 0),
  });

  const commit = useAdminMutation({
    mutationFn: () =>
      commitFn({
        data: {
          tenantId: tenantId!,
          orderId: orderId!,
          bookingId: bookingId!,
          amount,
          clientRequestId: requestId,
          closeWhenSettled: true,
        },
      }),
    successMessage: "Charged to room",
    onSuccess: (result: any) => {
      if (result?.posted) {
        setFailure(null);
        onPosted(result);
        return;
      }
      setFailure(
        result?.status === "unknown"
          ? `${result?.message ?? "Posting status unknown."} Do not retry — verify the folio with reception first.`
          : (result?.message ?? "The property system refused the charge."),
      );
    },
  });

  const list = ((stays.data as any)?.stays ?? []) as any[];
  const selected = list.find((s) => s.bookingId === bookingId) ?? null;
  const verdict = quote.data as any;
  const canPost = Boolean(bookingId && verdict?.eligible && !commit.isPending);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Charge {money(amount, currency)} to a room</DialogTitle>
          <DialogDescription>
            The charge is posted to the guest folio first. Only a confirmed posting settles this bill.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Room number, reservation or guest name</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-3 size-4 text-muted-foreground" />
              <Input
                className="pl-8"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="e.g. 12 or Kimaro"
              />
            </div>
          </div>

          <div className="max-h-56 space-y-2 overflow-y-auto">
            {stays.isLoading && <p className="text-sm text-muted-foreground">Looking up in-house guests…</p>}
            {!stays.isLoading && list.length === 0 && (
              <p className="text-sm text-muted-foreground">No checked-in stay matches that search.</p>
            )}
            {list.map((s) => (
              <button
                key={s.bookingId}
                type="button"
                onClick={() => {
                  setBookingId(s.bookingId);
                  setFailure(null);
                }}
                className={`flex w-full items-center justify-between rounded-lg border p-3 text-left ${
                  bookingId === s.bookingId ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <BedDouble className="size-4" /> {s.unitLabel ?? s.roomName ?? "—"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.guestName} · {s.arrival} → {s.departure}
                  </span>
                </span>
                <Badge variant="outline">{s.currency}</Badge>
              </button>
            ))}
          </div>

          {selected && verdict && !verdict.eligible && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {verdict.message}
            </p>
          )}
          {selected && verdict?.eligible && (
            <div className="rounded-lg border border-primary/50 bg-primary/5 p-3 text-sm">
              Charging {money(amount, currency)} to {verdict.stay?.room} — {verdict.stay?.guest}. This appears on the
              guest's folio immediately.
            </div>
          )}
          {failure && (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {failure}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-12" onClick={onClose}>
            Cancel
          </Button>
          <Button className="min-h-12" disabled={!canPost} onClick={() => commit.mutate(undefined as never)}>
            {commit.isPending ? "Posting to folio…" : `Post ${money(amount, currency)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
