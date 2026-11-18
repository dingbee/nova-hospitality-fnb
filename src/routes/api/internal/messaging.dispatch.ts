import { createFileRoute } from "@tanstack/react-router";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { processPendingMetaWebhookEvents } from "@/modules/messaging/webhook-queue.server";
import { processPendingWhatsAppOutboundMessages } from "@/modules/messaging/outbound-queue.server";
import {
  processDueWhatsAppCampaigns,
  reconcileWhatsAppCampaignUsage,
} from "@/modules/messaging/campaign-governance.server";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function dispatch(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "dispatcher_not_configured" }, { status: 503 });
  }
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const inbound = await processPendingMetaWebhookEvents(supabaseAdmin, {
      limit: 25,
      workerId: randomUUID(),
    });
    const campaigns = await processDueWhatsAppCampaigns(supabaseAdmin, { limit: 10 });
    const outbound = await processPendingWhatsAppOutboundMessages(supabaseAdmin, {
      limit: 25,
      workerId: randomUUID(),
    });
    const campaignUsageReconciliation = await reconcileWhatsAppCampaignUsage(supabaseAdmin, {
      limit: 100,
    });
    return Response.json(
      { inbound, campaigns, outbound, campaignUsageReconciliation },
      {
        headers: { "Cache-Control": "no-store, private, max-age=0" },
      },
    );
  } catch {
    return Response.json({ error: "webhook_dispatch_failed" }, { status: 503 });
  }
}

export const Route = createFileRoute("/api/internal/messaging/dispatch")({
  server: {
    handlers: {
      GET: async ({ request }) => dispatch(request),
      POST: async ({ request }) => dispatch(request),
    },
  },
});
