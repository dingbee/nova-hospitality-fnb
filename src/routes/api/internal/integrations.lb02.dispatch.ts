import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { signLb01Request } from "@/modules/api-platform/lb01.service-auth";
import { decryptLb01PeerCredential, validateLb01PeerBaseUrl } from "@/modules/api-platform/lb01.handoff.server";

type Db = {
  from(table: string): any;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
};
type Connection = { id: string; remote_product: string; integration_property_id: string; correlation_id: string };
type Event = {
  event_id: string; event_type: string; event_version: number; aggregate_id: string;
  aggregate_version: number; correlation_id: string; idempotency_key: string; payload: Record<string, unknown>;
  attempt_count: number;
};

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret) return false;
  const a = Buffer.from(supplied), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function dispatch(admin: Db, connection: Connection, peerBase: URL) {
  const credentialResult = await admin.from("lb01_peer_credentials")
    .select("peer_product,encrypted_token,encryption_iv,encryption_tag,status")
    .eq("connection_id", connection.id).maybeSingle();
  const peer = credentialResult.data as {
    peer_product: string; encrypted_token: unknown; encryption_iv: unknown;
    encryption_tag: unknown; status: string;
  } | null;
  if (credentialResult.error || !peer || peer.status !== "active" || peer.peer_product !== "staynas") {
    throw new Error("peer_credential_unavailable");
  }
  const token = decryptLb01PeerCredential({
    ciphertext: peer.encrypted_token, iv: peer.encryption_iv, tag: peer.encryption_tag,
    connectionId: connection.id, peerProduct: peer.peer_product,
  });
  const claimed = await admin.rpc("lb02_claim_outlet_outbox", { _connection_id: connection.id, _limit: 25 });
  if (claimed.error) throw new Error("outbox_claim_failed");
  const events = Array.isArray(claimed.data) ? claimed.data as Event[] : [];
  let delivered = 0, retried = 0, deadLettered = 0;
  for (const event of events) {
    let status = 0;
    let outcome: "accepted" | "retryable_failure" | "terminal_failure" = "retryable_failure";
    let code = "peer_transport_error";
    try {
      if (event.correlation_id !== connection.correlation_id) throw new Error("correlation_scope_mismatch");
      const body = JSON.stringify({
        sourceEventId: event.event_id, eventType: event.event_type, eventVersion: event.event_version,
        integrationPropertyId: connection.integration_property_id, aggregateId: event.aggregate_id,
        aggregateVersion: event.aggregate_version, correlationId: event.correlation_id,
        idempotencyKey: event.idempotency_key, payload: event.payload,
      });
      const url = new URL("/api/integrations/lb02/events", peerBase);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(24).toString("base64url");
      const secret = token.slice(token.lastIndexOf("_") + 1);
      const signature = await signLb01Request(secret, {
        method: "POST", pathname: url.pathname + url.search, rawBody: body, timestamp, nonce,
      });
      const response = await fetch(url, {
        method: "POST", redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-lb01-timestamp": timestamp, "x-lb01-nonce": nonce, "x-lb01-signature": signature,
          ...(process.env.LB01_PEER_VERCEL_BYPASS_SECRET
            ? { "x-vercel-protection-bypass": process.env.LB01_PEER_VERCEL_BYPASS_SECRET } : {}),
        },
        body, signal: AbortSignal.timeout(12_000),
      });
      status = response.status;
      if (response.ok) {
        const result = await response.json() as { accepted?: boolean };
        if (result.accepted !== true) throw new Error("peer_acceptance_missing");
        outcome = "accepted"; code = "";
      } else if (status >= 500 || status === 408 || status === 429) {
        code = `peer_http_${status}`;
      } else {
        outcome = "terminal_failure"; code = `peer_http_${status}`;
      }
    } catch (error) {
      code = error instanceof Error ? error.message.slice(0, 80) : "peer_transport_error";
      if (code === "correlation_scope_mismatch") outcome = "terminal_failure";
    }
    const recorded = await admin.rpc("lb02_record_outlet_delivery", {
      _event_id: event.event_id, _outcome: outcome, _http_status: status || null, _error_code: code || null,
    });
    if (recorded.error) throw new Error("delivery_evidence_write_failed");
    if (outcome === "accepted") delivered++;
    else if (outcome === "terminal_failure") deadLettered++;
    else retried++;
  }
  return { claimed: events.length, delivered, retried, deadLettered };
}

export const Route = createFileRoute("/api/internal/integrations/lb02/dispatch")({
  server: { handlers: {
    POST: async ({ request }) => {
      if (!authorized(request)) return Response.json({ error: "unauthorized_or_unconfigured" }, { status: 401 });
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as Db;
        const peerBase = validateLb01PeerBaseUrl();
        const result = await admin.from("staynas_product_connections")
          .select("id,remote_product,integration_property_id,correlation_id")
          .eq("remote_product", "staynas").eq("status", "active");
        if (result.error) throw new Error("connection_lookup_failed");
        const connections = (result.data ?? []) as Connection[];
        const totals = { connections: connections.length, claimed: 0, delivered: 0, retried: 0, deadLettered: 0 };
        for (const connection of connections) {
          try {
            const value = await dispatch(admin, connection, peerBase);
            totals.claimed += value.claimed; totals.delivered += value.delivered;
            totals.retried += value.retried; totals.deadLettered += value.deadLettered;
          } catch {
            // A connection-level failure is isolated; leased events become claimable after lease expiry.
          }
        }
        return Response.json(totals, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "lb02_dispatch_failed" }, { status: 503 });
      }
    },
  } },
});
