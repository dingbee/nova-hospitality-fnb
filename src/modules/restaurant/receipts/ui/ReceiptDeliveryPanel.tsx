/* eslint-disable @typescript-eslint/no-explicit-any -- receipt rows are untyped at this boundary. */
/**
 * The delivery act, next to the receipt it belongs to. It never redraws money:
 * it takes an already-issued receipt and tries to hand a copy to the guest,
 * reporting exactly what the provider said — no more.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Link2, Mail, MessageCircle, Printer, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/os/StatusChip";
import {
  listReceiptDeliveriesFn,
  receiptDeliveryProvidersFn,
  requestReceiptDeliveryFn,
} from "../delivery.functions";
import {
  DELIVERY_FAILURE_MESSAGES,
  buildReceiptMessage,
  isValidEmail,
  normalizePhone,
  whatsAppShareUrl,
  type DeliveryRecord,
} from "../delivery.types";

function newKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ReceiptDeliveryPanel({
  tenantId,
  receiptId,
  orderId,
  receiptNumber,
  total,
  onPrint,
}: {
  tenantId: string;
  receiptId?: string;
  orderId?: string;
  receiptNumber: string;
  total: string;
  onPrint?: () => void;
}) {
  const request = useServerFn(requestReceiptDeliveryFn);
  const listFn = useServerFn(listReceiptDeliveriesFn);
  const providersFn = useServerFn(receiptDeliveryProvidersFn);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, DeliveryRecord>>({});

  const providers = useQuery({
    queryKey: ["restaurant.receipt.providers"],
    queryFn: () => providersFn() as any,
  });

  const history = useQuery({
    queryKey: ["restaurant.receipt.deliveries", tenantId, receiptId],
    enabled: Boolean(tenantId && receiptId),
    queryFn: () => listFn({ data: { tenantId, receiptId, limit: 20 } }) as any,
  });

  const attempts = ((history.data as DeliveryRecord[]) ?? []) as DeliveryRecord[];
  const whatsappConfigured = Boolean((providers.data as any)?.whatsapp);

  const shareMessage = useMemo(
    () => buildReceiptMessage({ receiptNumber, total, link: last["whatsapp"]?.shareUrl ?? null }),
    [receiptNumber, total, last],
  );

  async function send(method: "print" | "email" | "whatsapp" | "secure_link", recipient?: string) {
    setBusy(method);
    try {
      const rec = (await request({
        data: { tenantId, receiptId, orderId, method, recipient, idempotencyKey: newKey(method) },
      })) as any as DeliveryRecord;
      setLast((s) => ({ ...s, [method]: rec }));
      void history.refetch();
      if (rec.status === "failed") toast.error(rec.failureReason ?? "Delivery failed.");
      else if (rec.status === "shared") {
        window.open(whatsAppShareUrl(rec.recipient, buildReceiptMessage({ receiptNumber, total, link: rec.shareUrl })), "_blank", "noopener");
        toast.message("WhatsApp opened for sharing — this is not a confirmed delivery.");
      } else if (method === "secure_link" && rec.shareUrl) {
        await navigator.clipboard?.writeText(rec.shareUrl).catch(() => undefined);
        toast.success("Secure receipt link copied.");
      } else toast.success(method === "print" ? "Print recorded." : "Receipt sent.");
    } catch (e: any) {
      toast.error(e?.message ?? "The delivery request could not be recorded.");
    } finally {
      setBusy(null);
    }
  }

  const emailOk = isValidEmail(email);
  const phoneOk = Boolean(normalizePhone(phone));

  return (
    <div className="space-y-4 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusChip tone="success">Issued</StatusChip>
        <StatusChip tone="success">Paid</StatusChip>
        {Object.values(last).map((r) => (
          <StatusChip key={r.id} tone={r.status === "failed" ? "danger" : r.status === "shared" ? "warning" : "success"}>
            {r.status === "failed"
              ? `${labelFor(r.method)} failed`
              : r.status === "shared"
                ? "WhatsApp opened for sharing"
                : `${labelFor(r.method)} sent`}
          </StatusChip>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="rcp-email" className="text-xs text-muted-foreground">
            Email receipt to
          </Label>
          <Input
            id="rcp-email"
            type="email"
            inputMode="email"
            placeholder="guest@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {email.length > 0 && !emailOk && (
            <p className="text-xs text-destructive">{DELIVERY_FAILURE_MESSAGES.invalid_email}</p>
          )}
          <Button
            className="min-h-11 w-full"
            variant="outline"
            disabled={!emailOk || busy !== null}
            onClick={() => send("email", email)}
          >
            <Mail className="mr-1 size-4" />
            {busy === "email" ? "Sending…" : last["email"]?.status === "failed" ? "Retry email" : "Send email"}
          </Button>
          {last["email"]?.status === "failed" && (
            <p className="flex items-start gap-1 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" /> {last["email"]?.failureReason}
            </p>
          )}
          {last["email"]?.status === "sent" && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3" /> Accepted by the mail provider · {last["email"]?.recipient}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="rcp-phone" className="text-xs text-muted-foreground">
            WhatsApp number
          </Label>
          <Input
            id="rcp-phone"
            inputMode="tel"
            placeholder="+255 712 345 678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          {phone.length > 0 && !phoneOk && (
            <p className="text-xs text-destructive">{DELIVERY_FAILURE_MESSAGES.invalid_phone}</p>
          )}
          <Button
            className="min-h-11 w-full"
            variant="outline"
            disabled={!phoneOk || busy !== null}
            onClick={() => send("whatsapp", phone)}
          >
            <MessageCircle className="mr-1 size-4" />
            {busy === "whatsapp" ? "Working…" : whatsappConfigured ? "Send on WhatsApp" : "Open WhatsApp"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {whatsappConfigured
              ? "Sent through the WhatsApp Business provider; delivery is confirmed only when the provider reports it."
              : "No WhatsApp Business provider is configured — this opens WhatsApp with the receipt link. Sharing is not delivery."}
          </p>
          {!whatsappConfigured && shareMessage.length === 0 && null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy !== null}
          onClick={() => {
            onPrint?.();
            void send("print");
          }}
        >
          <Printer className="mr-1 size-4" /> Print
        </Button>
        <Button variant="ghost" className="min-h-11" disabled={busy !== null} onClick={() => send("secure_link")}>
          <Link2 className="mr-1 size-4" /> Copy secure link
        </Button>
      </div>

      {attempts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Delivery attempts</p>
          {attempts.map((a) => (
            <DeliveryRow key={a.id} attempt={a} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DeliveryRow({ attempt }: { attempt: DeliveryRecord }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs">
      <span className="min-w-0">
        <span className="font-medium">{labelFor(attempt.method)}</span> · attempt {attempt.attempt} ·{" "}
        {attempt.recipient ?? "—"}
        <span className="block text-muted-foreground">
          {String(attempt.requestedAt).replace("T", " ").slice(0, 16)}
          {attempt.providerReference ? ` · ref ${attempt.providerReference}` : ""}
          {attempt.failureReason ? ` · ${attempt.failureReason}` : ""}
        </span>
      </span>
      <StatusChip
        tone={attempt.status === "failed" ? "danger" : attempt.status === "shared" ? "warning" : attempt.status === "pending" ? "neutral" : "success"}
      >
        {attempt.status === "shared" ? "opened for sharing" : attempt.status}
      </StatusChip>
    </div>
  );
}

function labelFor(method: string) {
  return method === "secure_link" ? "Secure link" : method === "whatsapp" ? "WhatsApp" : method === "email" ? "Email" : "Print";
}