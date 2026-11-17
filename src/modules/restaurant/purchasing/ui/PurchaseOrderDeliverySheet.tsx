/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Send an already-approved purchase order to its supplier.
 *
 * This sheet never touches the order itself — it only reads the canonical,
 * already-governed record and its supplier, then attempts a delivery. It
 * reports exactly what the provider said, never more: WhatsApp with no
 * configured provider opens a manual share link, and that is labelled as
 * sharing, not delivery.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Mail, MessageCircle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusChip } from "@/components/os/StatusChip";
import { getRestaurantPurchaseOrderDetailFn } from "../purchasing.functions";
import {
  listPoDeliveriesFn,
  poDeliveryProvidersFn,
  requestPoDeliveryFn,
} from "../poDelivery.functions";
import {
  PO_DELIVERY_FAILURE_MESSAGES,
  isValidEmail,
  normalizePhone,
  whatsAppShareUrl,
  type PoDeliveryRecord,
} from "../poDelivery.types";

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  purchaseOrderId: string | null;
}

export function PurchaseOrderDeliverySheet({
  open,
  onOpenChange,
  tenantId,
  purchaseOrderId,
}: Props) {
  const detailFn = useServerFn(getRestaurantPurchaseOrderDetailFn);
  const request = useServerFn(requestPoDeliveryFn);
  const listFn = useServerFn(listPoDeliveriesFn);
  const providersFn = useServerFn(poDeliveryProvidersFn);

  const detail = useQuery({
    queryKey: ["restaurant.purchase-order.detail", tenantId, purchaseOrderId],
    queryFn: () => detailFn({ data: { tenantId, id: purchaseOrderId! } }),
    enabled: open && Boolean(purchaseOrderId),
  });
  const providers = useQuery({
    queryKey: ["restaurant.po-delivery.providers"],
    queryFn: () => providersFn() as any,
    enabled: open,
  });
  const history = useQuery({
    queryKey: ["restaurant.po-deliveries", tenantId, purchaseOrderId],
    enabled: open && Boolean(tenantId && purchaseOrderId),
    queryFn: () =>
      listFn({ data: { tenantId, purchaseOrderId: purchaseOrderId!, limit: 20 } }) as any,
  });

  const d = detail.data as any;
  const order = d?.order;
  const supplier = d?.supplier;
  const preferredChannel = supplier?.metadata?.preferredChannel as "email" | "whatsapp" | undefined;
  const whatsappConfigured = Boolean((providers.data as any)?.whatsapp);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, PoDeliveryRecord>>({});

  const attempts = ((history.data as PoDeliveryRecord[]) ?? []) as PoDeliveryRecord[];

  async function send(method: "email" | "whatsapp", recipient: string) {
    if (!purchaseOrderId) return;
    setBusy(method);
    try {
      const rec = (await request({
        data: { tenantId, purchaseOrderId, method, recipient, idempotencyKey: newKey(method) },
      })) as any as PoDeliveryRecord;
      setLast((s) => ({ ...s, [method]: rec }));
      void history.refetch();
      if (rec.status === "failed") toast.error(rec.failureReason ?? "Sending failed.");
      else if (rec.status === "shared") {
        window.open(
          whatsAppShareUrl(rec.recipient, `Purchase order ${order?.document_number ?? ""}`),
          "_blank",
          "noopener",
        );
        toast.message("WhatsApp opened for sharing — this is not a confirmed delivery.");
      } else
        toast.success(
          method === "email" ? "Purchase order emailed." : "Purchase order sent on WhatsApp.",
        );
    } catch (e: any) {
      toast.error(e?.message ?? "The purchase order could not be sent.");
    } finally {
      setBusy(null);
    }
  }

  async function sendBoth() {
    if (emailOk) await send("email", email);
    if (phoneOk) await send("whatsapp", phone);
  }

  const emailValue = email || supplier?.email || "";
  const phoneValue = phone || supplier?.phone || "";
  const emailOk = isValidEmail(emailValue);
  const phoneOk = Boolean(normalizePhone(phoneValue));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>Send to supplier</SheetTitle>
          <SheetDescription>
            {order
              ? `${order.document_number ?? order.reference} — ${order.currency} ${Number(order.total ?? 0).toLocaleString()}`
              : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {!supplier ? (
            <p className="text-sm text-muted-foreground">
              {detail.isLoading
                ? "Loading order…"
                : "This purchase order has no supplier on file — add one before sending."}
            </p>
          ) : (
            <>
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">{supplier.name}</p>
                {preferredChannel ? (
                  <p className="text-xs text-muted-foreground">
                    Prefers {preferredChannel === "email" ? "email" : "WhatsApp"}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="po-email" className="text-xs text-muted-foreground">
                  Email
                </Label>
                <Input
                  id="po-email"
                  type="email"
                  inputMode="email"
                  placeholder="purchasing@supplier.com"
                  value={emailValue}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {emailValue.length > 0 && !emailOk && (
                  <p className="text-xs text-destructive">
                    {PO_DELIVERY_FAILURE_MESSAGES.invalid_email}
                  </p>
                )}
                <Button
                  className="min-h-11 w-full"
                  variant="outline"
                  disabled={!emailOk || busy !== null}
                  onClick={() => send("email", emailValue)}
                >
                  <Mail className="mr-1 size-4" />
                  {busy === "email"
                    ? "Sending…"
                    : last["email"]?.status === "failed"
                      ? "Retry email"
                      : "Send email"}
                </Button>
                {last["email"]?.status === "failed" && (
                  <p className="flex items-start gap-1 text-xs text-destructive">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />{" "}
                    {last["email"]?.failureReason}
                  </p>
                )}
                {last["email"]?.status === "sent" && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="size-3" /> Accepted by the mail provider ·{" "}
                    {last["email"]?.recipient}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="po-phone" className="text-xs text-muted-foreground">
                  WhatsApp
                </Label>
                <Input
                  id="po-phone"
                  inputMode="tel"
                  placeholder="+255 712 345 678"
                  value={phoneValue}
                  onChange={(e) => setPhone(e.target.value)}
                />
                {phoneValue.length > 0 && !phoneOk && (
                  <p className="text-xs text-destructive">
                    {PO_DELIVERY_FAILURE_MESSAGES.invalid_phone}
                  </p>
                )}
                <Button
                  className="min-h-11 w-full"
                  variant="outline"
                  disabled={!phoneOk || busy !== null}
                  onClick={() => send("whatsapp", phoneValue)}
                >
                  <MessageCircle className="mr-1 size-4" />
                  {busy === "whatsapp"
                    ? "Working…"
                    : whatsappConfigured
                      ? "Send on WhatsApp"
                      : "Open WhatsApp"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {whatsappConfigured
                    ? "Sent through the WhatsApp Business provider; delivery is confirmed only when the provider reports it."
                    : "No WhatsApp Business provider is configured — this opens WhatsApp with the order summary. Sharing is not delivery."}
                </p>
              </div>

              {emailOk && phoneOk ? (
                <Button
                  variant="secondary"
                  className="min-h-11 w-full"
                  disabled={busy !== null}
                  onClick={() => void sendBoth()}
                >
                  Send email + WhatsApp
                </Button>
              ) : null}

              {attempts.length > 0 && (
                <div className="space-y-1 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Communication history</p>
                  {attempts.map((a) => (
                    <DeliveryRow key={a.id} attempt={a} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t bg-background px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeliveryRow({ attempt }: { attempt: PoDeliveryRecord }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs">
      <span className="min-w-0">
        <span className="font-medium">{attempt.method === "email" ? "Email" : "WhatsApp"}</span> ·
        attempt {attempt.attempt} · {attempt.recipient ?? "—"}
        <span className="block text-muted-foreground">
          {String(attempt.requestedAt).replace("T", " ").slice(0, 16)}
          {attempt.providerReference ? ` · ref ${attempt.providerReference}` : ""}
          {attempt.failureReason ? ` · ${attempt.failureReason}` : ""}
        </span>
      </span>
      <StatusChip
        tone={
          attempt.status === "failed"
            ? "danger"
            : attempt.status === "shared"
              ? "warning"
              : attempt.status === "pending"
                ? "neutral"
                : "success"
        }
      >
        {attempt.status === "shared" ? "opened for sharing" : attempt.status}
      </StatusChip>
    </div>
  );
}
