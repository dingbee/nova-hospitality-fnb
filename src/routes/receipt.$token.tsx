import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getSharedReceiptFn } from "@/modules/restaurant/receipts/delivery.functions";
import { PRODUCT } from "@/config/product";

export const Route = createFileRoute("/receipt/$token")({
  head: () => ({
    meta: [
      { title: `Receipt — ${PRODUCT.guestFacingName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  loader: async ({ params }) => getSharedReceiptFn({ data: { token: params.token } }),
  component: GuestReceiptPage,
});

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function GuestReceiptPage() {
  const result = Route.useLoaderData();

  useEffect(() => {
    const shouldPrint = new URLSearchParams(window.location.search).get("print") === "1";
    if (!shouldPrint) return;
    const timer = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timer);
  }, []);

  if (!result.ok) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center">
        <div className="max-w-sm">
          <h1 className="font-display text-2xl">Receipt unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This receipt link is no longer available. Please ask the restaurant for a new copy.
          </p>
        </div>
      </main>
    );
  }

  const { receipt } = result;

  return (
    <>
      <style>{`
        @media print {
          .receipt-actions { display: none !important; }
          .receipt-page { min-height: auto !important; padding: 0 !important; background: white !important; }
          .receipt-card { box-shadow: none !important; border: 0 !important; max-width: 80mm !important; }
        }
      `}</style>

      <main className="receipt-page min-h-dvh bg-muted/30 px-4 py-8">
        <div className="receipt-card mx-auto max-w-md rounded-2xl border bg-card p-5 shadow-sm">
          <div className="text-center">
            <p className="eyebrow">{PRODUCT.guestFacingName}</p>
            <h1 className="font-display mt-1 text-2xl">Receipt</h1>
            <p className="mt-1 text-xs text-muted-foreground">{receipt.number}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {new Date(receipt.issuedAt).toLocaleString()}
            </p>
          </div>

          <div className="mt-5 space-y-2 border-y py-4">
            {receipt.lines.map((line, index) => (
              <div key={`${line.description}-${index}`} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-muted-foreground">Qty {line.quantity}</p>
                </div>
                <span className="shrink-0 font-medium">
                  {money(line.amount, receipt.currency)}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{money(receipt.subtotal, receipt.currency)}</span>
            </div>
            {receipt.discountTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span>-{money(receipt.discountTotal, receipt.currency)}</span>
              </div>
            )}
            {receipt.taxTotal > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>{money(receipt.taxTotal, receipt.currency)}</span>
              </div>
            )}
            {receipt.serviceCharge > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Service charge</span>
                <span>{money(receipt.serviceCharge, receipt.currency)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <span>Total</span>
              <span>{money(receipt.total, receipt.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Paid</span>
              <span className="font-medium">{money(receipt.paid, receipt.currency)}</span>
            </div>
          </div>

          {receipt.payments.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Payment
              </p>
              <div className="mt-2 space-y-1.5 text-sm">
                {receipt.payments.map((payment, index) => (
                  <div key={`${payment.method}-${index}`} className="flex justify-between gap-3">
                    <span className="capitalize">{payment.method.replaceAll("_", " ")}</span>
                    <span>{money(payment.amount, receipt.currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="receipt-actions mt-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="min-h-11 rounded-full border px-4 text-sm font-medium"
            >
              Save / Print
            </button>
            <button
              type="button"
              onClick={() => window.close()}
              className="min-h-11 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Done
            </button>
          </div>

          <p className="receipt-actions mt-3 text-center text-[11px] text-muted-foreground">
            Use your browser's print dialog to save this receipt as a PDF.
          </p>
        </div>
      </main>
    </>
  );
}
