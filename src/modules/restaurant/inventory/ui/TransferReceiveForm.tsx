/**
 * Transfer receiving — quantity verification at the destination.
 *
 * The receiver records what actually arrived for THIS delivery: accepted
 * (credited to the destination ledger), rejected and damaged (never
 * credited; a reason is mandatory). Several partial receipts can be
 * recorded against one dispatch. The server re-validates every number and
 * refuses a stale form (another receiver got there first) instead of
 * counting the same goods twice.
 */
import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import { formatQuantity } from "@/modules/restaurant/ui/presentation";
import { closeStockTransferFn, receiveStockTransferFn } from "../control.functions";

export interface ReceivableTransferLine {
  id: string;
  label: string;
  dispatched: number;
  received: number;
  rejected: number;
  damaged: number;
}

type Draft = { received: string; rejected: string; damaged: string; notes: string };

export function TransferReceiveForm({
  tenantId,
  transferId,
  lines,
  canClose,
  onDone,
  invalidateKeys = [],
}: {
  tenantId: string;
  transferId: string;
  lines: ReceivableTransferLine[];
  /** Shows the governed short-close action (transfer.approve holders). */
  canClose?: boolean;
  onDone?: () => void;
  invalidateKeys?: unknown[][];
}) {
  const qc = useQueryClient();
  const receiveFn = useServerFn(receiveStockTransferFn);
  const closeFn = useServerFn(closeStockTransferFn);
  const outstandingOf = (l: ReceivableTransferLine) =>
    Math.max(0, l.dispatched - l.received - l.rejected - l.damaged);

  const [draft, setDraft] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.id,
        { received: String(outstandingOf(l)), rejected: "0", damaged: "0", notes: "" },
      ]),
    ),
  );
  const [closeReason, setCloseReason] = React.useState("");

  const refresh = () => {
    for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    onDone?.();
  };

  const receive = useAdminMutation({
    mutationFn: () =>
      receiveFn({
        data: {
          tenantId,
          transferId,
          lines: lines
            .filter((l) => outstandingOf(l) > 0)
            .map((l) => {
              const d = draft[l.id]!;
              return {
                lineId: l.id,
                receivedQuantity: Number(d.received || 0),
                rejectedQuantity: Number(d.rejected || 0),
                damagedQuantity: Number(d.damaged || 0),
                expectedPriorAccounted: l.received + l.rejected + l.damaged,
                notes: d.notes || undefined,
              };
            }),
        },
      }),
    successMessage: "Receipt recorded — accepted stock posted to the destination ledger.",
    onSuccess: refresh,
  });

  const close = useAdminMutation({
    mutationFn: () => closeFn({ data: { tenantId, transferId, reason: closeReason } }),
    successMessage: "Transfer closed with its in-transit variance recorded.",
    onSuccess: refresh,
  });

  const open = lines.filter((l) => outstandingOf(l) > 0);
  if (open.length === 0) {
    return <p className="text-xs text-muted-foreground">Every dispatched unit is accounted for.</p>;
  }

  const set = (id: string, field: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id]!, [field]: value } }));

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {open.map((l) => {
          const d = draft[l.id]!;
          const needsReason = Number(d.rejected || 0) + Number(d.damaged || 0) > 0;
          return (
            <li key={l.id} className="space-y-2 rounded-md border p-2">
              <div className="flex flex-wrap justify-between gap-2 text-xs">
                <span className="font-medium">{l.label}</span>
                <span className="text-muted-foreground">
                  dispatched {formatQuantity(l.dispatched)} · already accounted{" "}
                  {formatQuantity(l.received + l.rejected + l.damaged)} · in transit{" "}
                  {formatQuantity(outstandingOf(l))}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs">
                  Accepted
                  <Input
                    inputMode="decimal"
                    value={d.received}
                    aria-label={`Accepted quantity for ${l.label}`}
                    onChange={(e) => set(l.id, "received", e.target.value)}
                  />
                </label>
                <label className="text-xs">
                  Rejected
                  <Input
                    inputMode="decimal"
                    value={d.rejected}
                    aria-label={`Rejected quantity for ${l.label}`}
                    onChange={(e) => set(l.id, "rejected", e.target.value)}
                  />
                </label>
                <label className="text-xs">
                  Damaged
                  <Input
                    inputMode="decimal"
                    value={d.damaged}
                    aria-label={`Damaged quantity for ${l.label}`}
                    onChange={(e) => set(l.id, "damaged", e.target.value)}
                  />
                </label>
              </div>
              {needsReason && (
                <Input
                  placeholder="Reason for rejected / damaged stock (required)"
                  value={d.notes}
                  onChange={(e) => set(l.id, "notes", e.target.value)}
                />
              )}
            </li>
          );
        })}
      </ul>
      <Button size="sm" disabled={receive.isPending} onClick={() => receive.mutate()}>
        Record receipt
      </Button>
      {canClose && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Close short only when the remaining in-transit quantity will never arrive. Nothing is
            credited; the shortfall is recorded as a variance.
          </p>
          <Textarea
            placeholder="Reason the remaining quantity will not be received (min. 10 characters)"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={close.isPending || closeReason.trim().length < 10}
            onClick={() => close.mutate()}
          >
            Close with variance
          </Button>
        </div>
      )}
    </div>
  );
}
