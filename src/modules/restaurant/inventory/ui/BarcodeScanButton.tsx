import { useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Minimal shape of the browser-native Barcode Detection API. Not in the
 * standard DOM lib types yet, so it's declared narrowly here rather than
 * pulling in a polyfill or an OCR/ML dependency for what the platform
 * already does natively where it's available.
 */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

/**
 * Optional camera barcode capture, reused everywhere an item needs to be
 * looked up (receiving basket, stocktake counting). Feature-detected: on a
 * browser/device without BarcodeDetector support this renders nothing, and
 * every caller's manual search/entry field keeps working exactly as before
 * — scanning is never the only way in.
 */
export function BarcodeScanButton({ onScan }: { onScan: (code: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
  }, []);

  if (!supported) return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-11 w-11 shrink-0"
        title="Scan barcode"
        onClick={() => setOpen(true)}
      >
        <ScanLine className="h-5 w-5" />
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf: number | null = null;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const Detector = window.BarcodeDetector;
        if (!Detector) {
          setError("Barcode scanning is not supported on this device.");
          return;
        }
        const detector = new Detector();

        const tick = async () => {
          if (cancelled || !video) return;
          try {
            const results = await detector.detect(video);
            if (results.length > 0 && results[0]!.rawValue) {
              onScan(results[0]!.rawValue);
              return;
            }
          } catch {
            // A single failed detection frame is not fatal — keep scanning.
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
      } catch {
        if (!cancelled)
          setError("Camera access was denied or is unavailable. You can still type the barcode.");
      }
    }
    void start();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Scan barcode</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : (
          <video
            ref={videoRef}
            className="aspect-square w-full rounded-md bg-black object-cover"
            muted
            playsInline
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
