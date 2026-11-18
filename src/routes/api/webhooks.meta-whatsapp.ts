import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import {
  ingestMetaWhatsAppWebhook,
  MetaWebhookPersistenceError,
  MetaWebhookSignatureError,
} from "@/modules/messaging/webhooks.server";

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/webhooks/meta-whatsapp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const verifyToken = process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();
        if (!verifyToken) {
          return new Response("Webhook verification is not configured.", { status: 503 });
        }

        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode") ?? "";
        const suppliedToken = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";

        if (mode !== "subscribe" || !challenge || !constantTimeEqual(suppliedToken, verifyToken)) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      },

      POST: async ({ request }) => {
        const appSecret = process.env.META_APP_SECRET?.trim();
        if (!appSecret) {
          return Response.json({ error: "webhook_not_configured" }, { status: 503 });
        }

        if (Number(request.headers.get("content-length") ?? 0) > 262_144) {
          return Response.json({ error: "payload_too_large" }, { status: 413 });
        }
        const rawBody = await request.text();
        if (Buffer.byteLength(rawBody, "utf8") > 262_144) {
          return Response.json({ error: "payload_too_large" }, { status: 413 });
        }
        const signature = request.headers.get("x-hub-signature-256");

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const result = await ingestMetaWhatsAppWebhook(
            supabaseAdmin,
            rawBody,
            signature,
            appSecret,
          );
          return Response.json(
            { received: true, ...result },
            { headers: { "Cache-Control": "no-store, private, max-age=0" } },
          );
        } catch (error) {
          if (error instanceof MetaWebhookSignatureError) {
            return Response.json({ error: "invalid_signature" }, { status: 401 });
          }
          if (error instanceof MetaWebhookPersistenceError) {
            return Response.json({ error: "event_persistence_failed" }, { status: 503 });
          }
          return Response.json({ error: "webhook_unavailable" }, { status: 503 });
        }
      },
    },
  },
});
