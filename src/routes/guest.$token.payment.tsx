import { useServerFn } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { confirmGuestCommercePaymentFn } from "@/modules/messaging/guest-portal.functions";

export const Route = createFileRoute("/guest/$token/payment")({
  validateSearch: (search: Record<string, unknown>) => ({
    orderId: typeof search.orderId === "string" ? search.orderId : undefined,
    OrderTrackingId:
      typeof search.OrderTrackingId === "string" ? search.OrderTrackingId : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Payment confirmation — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: GuestPaymentReturn,
});

function GuestPaymentReturn() {
  const { token } = Route.useParams();
  const search = Route.useSearch();
  const confirmPayment = useServerFn(confirmGuestCommercePaymentFn);
  const hasCallback = Boolean(search.orderId && search.OrderTrackingId);
  const confirmation = useQuery({
    queryKey: ["guest-payment-return", token, search.orderId, search.OrderTrackingId],
    enabled: Boolean(search.orderId && search.OrderTrackingId),
    retry: false,
    queryFn: () =>
      confirmPayment({
        data: {
          token,
          orderId: search.orderId!,
          orderTrackingId: search.OrderTrackingId!,
        },
      }),
  });

  const message =
    confirmation.data?.ok && confirmation.data.status === "paid"
      ? "Payment confirmed. Your order has been released to the restaurant."
      : confirmation.data?.ok && confirmation.data.status === "pending"
        ? "The provider has not confirmed payment yet. Check again shortly."
        : confirmation.data && !confirmation.data.ok
          ? confirmation.data.reason === "amount_mismatch"
            ? "The payment amount or currency did not match this order. The order has not been marked as paid."
            : confirmation.data.reason === "already_paid"
              ? "This order is already paid."
              : confirmation.data.reason === "provider_not_configured"
                ? "The restaurant payment integration is currently unavailable."
                : "The payment was not completed. You can retry from your Guest Portal order."
          : confirmation.isError
            ? confirmation.error instanceof Error
              ? confirmation.error.message
              : "Payment confirmation could not be completed."
            : hasCallback
              ? "Waiting for the payment provider response."
              : "The payment provider did not return a verifiable transaction reference. The order has not been marked as paid.";

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      {hasCallback && confirmation.isPending ? (
        <LoaderCircle className="size-9 animate-spin text-primary" aria-hidden />
      ) : confirmation.data?.ok && confirmation.data.status === "paid" ? (
        <CheckCircle2 className="size-10 text-primary" aria-hidden />
      ) : (
        <CircleAlert className="size-10 text-muted-foreground" aria-hidden />
      )}
      <h1 className="text-xl font-semibold">Payment confirmation</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      {confirmation.data?.ok && confirmation.data.status === "pending" ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium"
          onClick={() => void confirmation.refetch()}
        >
          <RefreshCw className="size-4" aria-hidden />
          Check payment again
        </button>
      ) : null}
      <a
        href={`/guest/${token}`}
        className="rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
      >
        Return to Guest Portal
      </a>
    </main>
  );
}
