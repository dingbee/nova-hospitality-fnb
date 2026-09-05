/**
 * GEP6 — "View QR" viewer. Shows exactly the PNG "Download QR" saves
 * (same renderTableQrCard call), so preview and download can never drift
 * apart. Also offers "Copy link" (the real guest URL, never a raw table
 * id) — see qr.ts's buildGuestOrderUrl and qrRender.ts's file doc comment
 * for why decode correctness itself is proven elsewhere (qr.decode.test.ts)
 * rather than re-verified here on every render.
 */
import * as React from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { TableQrCard } from "../../qr";
import { copyTextToClipboard, downloadDataUrl, renderTableQrCard } from "../qrRender";

function slugForFilename(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function TableQrDialog({
  card,
  open,
  onOpenChange,
}: {
  card: TableQrCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open || !card) {
      setDataUrl(null);
      setError(null);
      setCopied(false);
      return;
    }
    let cancelled = false;
    renderTableQrCard(card)
      .then((rendered) => {
        if (!cancelled) setDataUrl(rendered.dataUrl);
      })
      .catch(() => {
        if (!cancelled) setError("Could not generate this QR right now. Please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, card]);

  if (!card) return null;

  const copyLink = async () => {
    await copyTextToClipboard(card.guestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          {/* The restaurant's own identity, front and center on-screen — the
              printed card also carries it, but at on-screen preview size
              that text renders too small to read, so the dialog restates it
              here rather than forking a second, preview-only render of the
              shared card image. */}
          <DialogTitle>{card.businessName}</DialogTitle>
          <DialogDescription>{card.tableLabel} · Scan to open the ordering menu</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-2.5">
          <div className="flex aspect-[3/4] w-full max-w-[220px] items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
            {error ? (
              <p className="px-4 text-center text-sm text-destructive">{error}</p>
            ) : dataUrl ? (
              <img
                src={dataUrl}
                alt={`QR code for ${card.businessName}, ${card.tableLabel} — scan to order`}
                className="size-full object-contain"
              />
            ) : (
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>

          <div className="w-full space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Guest ordering link</p>
            <button
              type="button"
              onClick={copyLink}
              title={card.guestUrl}
              aria-label={`Copy guest ordering link: ${card.guestUrl}`}
              className="w-full select-none truncate rounded-md bg-muted px-3 py-2 text-left font-mono text-xs text-foreground transition-colors hover:bg-muted/70"
            >
              {card.guestUrl}
            </button>
          </div>

          <div className="flex w-full gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={copyLink}>
              {copied ? (
                <Check className="mr-1 size-4" aria-hidden />
              ) : (
                <Copy className="mr-1 size-4" aria-hidden />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button
              type="button"
              className="h-11 flex-1"
              disabled={!dataUrl}
              onClick={() => {
                if (!dataUrl) return;
                downloadDataUrl(
                  dataUrl,
                  `${slugForFilename(card.businessName)}-${slugForFilename(card.tableLabel)}-qr.png`,
                );
              }}
            >
              <Download className="mr-1 size-4" aria-hidden />
              Download QR
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
