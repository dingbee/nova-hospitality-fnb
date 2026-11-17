import { useEffect, useState } from "react";
import { ScanLine } from "lucide-react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hasCameraApi } from "./camera-support";

/**
 * Camera barcode capture, reused everywhere an item needs to be looked up
 * (receiving basket, stocktake counting).
 *
 * Decodes with @zxing/browser (already a project dependency) rather than
 * the browser-native BarcodeDetector API: BarcodeDetector only ships in
 * Chromium, so gating on it left the scanner silently absent on iOS Safari
 * and Firefox — the majority of real staff phones. zxing decodes in pure
 * JS against a live video element, so the only real precondition is a
 * camera stream (`getUserMedia`), which every modern mobile browser
 * engine supports. Where that's genuinely unavailable, or permission is
 * denied, manual search/entry is always the working fallback — scanning
 * is never the only way in.
 */
export function BarcodeScanButton({
  onScan,
  label,
}: {
  onScan: (code: string) => void;
  /** A visible text label alongside the icon — an icon-only button reads fine tucked next to a search field (the receiving basket), but a primary "how do I count this" action needs to be unmistakable on its own, not a tooltip a thumb has to discover. Omit for the compact icon-only form. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const cameraApiAvailable = hasCameraApi(typeof navigator === "undefined" ? undefined : navigator);

  if (!cameraApiAvailable) {
    return (
      <Button
        type="button"
        variant="outline"
        size={label ? "default" : "icon"}
        className={label ? "h-11 shrink-0 gap-2 opacity-50" : "h-11 w-11 shrink-0 opacity-50"}
        disabled
        title="Camera scanning isn't available in this browser — search or type the barcode instead."
      >
        <ScanLine className="h-5 w-5" />
        {label && <span>{label} (unavailable)</span>}
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={label ? "default" : "icon"}
        className={label ? "h-11 shrink-0 gap-2" : "h-11 w-11 shrink-0"}
        title="Scan barcode"
        onClick={() => setOpen(true)}
      >
        <ScanLine className="h-5 w-5" />
        {label && <span>{label}</span>}
      </Button>
      {open && (
        <ScannerDialog
          onClose={() => setOpen(false)}
          onScan={(code) => {
            setOpen(false);
            onScan(code);
          }}
        />
      )}
    </>
  );
}

function ScannerDialog({
  onScan,
  onClose,
}: {
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  // A plain useRef here read as null on the effect's first run — Radix
  // Dialog.Content mounts its children (this <video>) on a later commit
  // than the wrapping ScannerDialog itself, so the ref wasn't attached
  // yet by the time the effect fired and the camera never actually
  // started. Verified against a real browser, not assumed: a callback ref
  // (state, so it re-renders and re-runs the effect once the node exists)
  // fixes it — the effect now depends on the actual DOM node, not a timing
  // assumption about when refs settle relative to Radix's own mount order.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoEl) return;
    let cancelled = false;
    let controls: IScannerControls | null = null;
    const reader = new BrowserMultiFormatReader();

    async function start() {
      try {
        const started = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoEl!,
          (result) => {
            // Fires on every decode attempt, success or not — a frame with
            // no visible barcode reports a (expected, non-fatal) not-found
            // error here rather than a result, so only a hit is terminal.
            if (cancelled || !result) return;
            controls?.stop();
            onScan(result.getText());
          },
        );
        if (cancelled) {
          started.stop();
          return;
        }
        controls = started;
      } catch {
        if (!cancelled)
          setError("Camera access was denied or is unavailable. You can still type the barcode.");
      }
    }
    void start();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [videoEl, onScan]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-sm"
        // Radix's own default here is to return focus to whatever
        // triggered the dialog once it closes — reasonable in general, but
        // it runs after onScan fires and silently overrides any focus a
        // caller's onScan handler tries to set (verified against a real
        // browser: a successful scan closed this dialog correctly, but the
        // caller's own follow-up focus() call never stuck — activeElement
        // settled on <body>). A caller that already has somewhere useful
        // for focus to land wins over this dialog's own opinion about it.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Scan barcode</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : (
          <video
            ref={setVideoEl}
            className="aspect-square w-full rounded-md bg-black object-cover"
            muted
            playsInline
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
