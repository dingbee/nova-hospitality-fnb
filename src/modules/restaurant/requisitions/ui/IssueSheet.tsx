/**
 * Issue sheet — post the approved (or partially issued) requisition through
 * the ledger, line by line. Outstanding = approved - already issued.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { EntitySheet, QuantityField } from "../../ui/forms";

interface IssueLine {
  id: string;
  itemName: string;
  requestedQuantity: number;
  approvedQuantity: number;
  issuedQuantity: number;
  outstandingQuantity: number;
}

interface IssueSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reference?: string;
  lines: IssueLine[];
  pending?: boolean;
  onSubmit: (payload: { lines: Array<{ lineId: string; issueQuantity: number }> }) => void;
}

export function IssueSheet({ open, onOpenChange, reference, lines, pending, onSubmit }: IssueSheetProps) {
  const [quantities, setQuantities] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    if (open) {
      setQuantities(Object.fromEntries(lines.map((l) => [l.id, l.outstandingQuantity])));
    }
  }, [open, lines]);

  const setAllOutstanding = () =>
    setQuantities(Object.fromEntries(lines.map((l) => [l.id, l.outstandingQuantity])));

  const canSubmit = lines.some((l) => (quantities[l.id] ?? 0) > 0);

  const submit = () => {
    onSubmit({
      lines: lines
        .map((l) => ({ lineId: l.id, issueQuantity: quantities[l.id] ?? 0 }))
        .filter((l) => l.issueQuantity > 0),
    });
  };

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Issue ${reference ?? "requisition"}`}
      description="Stock leaves the source store and enters the destination through the ledger."
      submitLabel="Issue"
      pending={pending}
      disabled={!canSubmit}
      onSubmit={submit}
      wide
      footerExtra={
        <Button type="button" variant="outline" className="h-11" onClick={setAllOutstanding} disabled={pending}>
          Issue all outstanding
        </Button>
      }
    >
      <div className="space-y-3">
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding to issue.</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{l.itemName}</span>
                <span className="text-xs text-muted-foreground">
                  requested {l.requestedQuantity} · approved {l.approvedQuantity} · issued {l.issuedQuantity} · outstanding{" "}
                  {l.outstandingQuantity}
                </span>
              </div>
              <QuantityField
                value={quantities[l.id] ?? 0}
                onChange={(v) => setQuantities((prev) => ({ ...prev, [l.id]: v }))}
                step={1}
                min={0}
                max={l.outstandingQuantity}
                disabled={l.outstandingQuantity <= 0}
              />
            </div>
          ))
        )}
      </div>
    </EntitySheet>
  );
}
