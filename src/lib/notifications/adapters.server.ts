/**
 * NOVA Hospitality F&B — outbound notification adapters.
 *
 * The product ships no vendor account of its own. Each deployment configures
 * its own provider through environment variables; when nothing is configured
 * the adapter says so plainly rather than pretending a message was delivered.
 * On-premise appliances routinely run with no WAN provider at all — that is a
 * supported state, not an error.
 */

export type AdapterResult =
  | { ok: true; provider: string; reference?: string }
  | { ok: false; provider: string; reason: "not_configured" | "rejected" | "network"; error?: string };

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/* ---------------------------------------------------------------- email --- */

/** Generic HTTP email relay: POST { to, subject, html, text } to the configured URL. */
export function emailConfigured(): boolean {
  return Boolean(env("NOVA_EMAIL_WEBHOOK_URL"));
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
}): Promise<AdapterResult> {
  const url = env("NOVA_EMAIL_WEBHOOK_URL");
  if (!url) return { ok: false, provider: "email", reason: "not_configured" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = env("NOVA_EMAIL_WEBHOOK_KEY");
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: env("NOVA_EMAIL_FROM") ?? "no-reply@nova-hospitality.local",
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text ?? null,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) return { ok: false, provider: "email", reason: "rejected", error: json?.message ?? `Provider responded ${res.status}.` };
    return { ok: true, provider: "email", reference: json?.id };
  } catch (e) {
    return { ok: false, provider: "email", reason: "network", error: (e as Error)?.message };
  }
}

/* ------------------------------------------------------------- whatsapp --- */

/** Twilio WhatsApp, called directly with the deployment's own credentials. */
export function whatsappConfigured(): boolean {
  return Boolean(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("WHATSAPP_FROM"));
}

export async function sendWhatsApp(to: string, body: string): Promise<AdapterResult> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const tokenSecret = env("TWILIO_AUTH_TOKEN");
  const from = env("WHATSAPP_FROM");
  if (!sid || !tokenSecret || !from) return { ok: false, provider: "twilio_whatsapp", reason: "not_configured" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${tokenSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: `whatsapp:${to}`, Body: body }),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, provider: "twilio_whatsapp", reason: "rejected", error: json?.message ?? `Provider responded ${res.status}.` };
    return { ok: true, provider: "twilio_whatsapp", reference: json?.sid };
  } catch (e) {
    return { ok: false, provider: "twilio_whatsapp", reason: "network", error: (e as Error)?.message };
  }
}

/* --------------------------------------------------------------- render --- */

export function renderReceiptEmail(data: {
  receiptNumber: string;
  outlet: string;
  issuedAt: string;
  total: string;
  paid: string;
  paymentStatus: string;
  lines: { description: string; quantity: number; amount: string }[];
  receiptUrl: string;
}): { subject: string; html: string; text: string } {
  const rows = data.lines
    .map(
      (l) =>
        `<tr><td style="padding:4px 8px">${escapeHtml(l.description)}</td><td style="padding:4px 8px;text-align:right">${l.quantity}</td><td style="padding:4px 8px;text-align:right">${escapeHtml(l.amount)}</td></tr>`,
    )
    .join("");
  const subject = `Receipt ${data.receiptNumber} — ${data.outlet}`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1a1a">
<h2 style="margin:0 0 4px">${escapeHtml(data.outlet)}</h2>
<p style="margin:0 0 16px;color:#666">Receipt ${escapeHtml(data.receiptNumber)} · ${escapeHtml(data.issuedAt)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
<p style="margin-top:16px"><strong>Total ${escapeHtml(data.total)}</strong><br/>Paid ${escapeHtml(data.paid)} · ${escapeHtml(data.paymentStatus)}</p>
<p><a href="${escapeHtml(data.receiptUrl)}">View receipt</a></p>
</body></html>`;
  const text = `${data.outlet}\nReceipt ${data.receiptNumber} (${data.issuedAt})\n${data.lines
    .map((l) => `${l.quantity} x ${l.description} — ${l.amount}`)
    .join("\n")}\nTotal ${data.total}\nPaid ${data.paid} (${data.paymentStatus})\n${data.receiptUrl}`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
