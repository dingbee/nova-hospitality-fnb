
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { issueLb01ServiceCredential } from "@/modules/api-platform/lb01.credentials.server";
import { sendLb01Approval } from "@/modules/api-platform/lb01.sender.server";
import {
  createLb01HandoffCode,
  decryptLb01PeerCredential,
  encryptLb01PeerCredential,
  hashLb01HandoffCode,
  validateLb01PeerBaseUrl,
} from "@/modules/api-platform/lb01.handoff.server";

type DbResult = { data: unknown; error: unknown };
type DbQuery = PromiseLike<DbResult> & {
  select(columns: string): DbQuery;
  eq(column: string, value: unknown): DbQuery;
  maybeSingle(): Promise<DbResult>;
  insert(values: Record<string, unknown>): Promise<{ error: unknown }>;
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
};
type DbClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<DbResult>;
  from(table: string): DbQuery;
};
type ConnectionRow = {
  id: string;
  remote_product: string;
  remote_tenant_id: string;
  remote_property_id: string;
  integration_tenant_id: string;
  integration_property_id: string;
  correlation_id: string;
  status: string;
  local_approved_at: string | null;
};

const createInput = z.object({
  localPropertyId: z.string().uuid(),
  remoteTenantId: z.string().uuid(),
  remotePropertyId: z.string().uuid(),
  integrationTenantId: z.string().uuid().optional(),
  integrationPropertyId: z.string().uuid().optional(),
  correlationId: z.string().min(8).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  const supplied = [value.integrationTenantId, value.integrationPropertyId, value.correlationId]
    .filter(Boolean).length;
  if (supplied !== 0 && supplied !== 3) {
    ctx.addIssue({ code: "custom", message: "A pairing invitation requires all canonical IDs and its correlation ID." });
  }
});
const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), ...createInput.shape }).strict(),
  z.object({ action: z.literal("issue_handoff"), connectionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("import_handoff"), connectionId: z.string().uuid(), code: z.string().min(43).max(43) }).strict(),
  z.object({ action: z.literal("approve"), connectionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("retry"), connectionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("revoke"), connectionId: z.string().uuid(), reason: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("list") }).strict(),
]);

async function authenticatedClient(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new Error("unauthorized");
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("supabase_configuration_missing");
  const client = createClient<Database>(url, key, {
    global: { headers: { Authorization: "Bearer " + match[1] } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data.user) throw new Error("unauthorized");
  return { user: data.user, client: client as unknown as DbClient };
}

async function connectionFor(admin: DbClient, connectionId: string): Promise<ConnectionRow> {
  const result = await admin.from("staynas_product_connections")
    .select("id, remote_product, remote_tenant_id, remote_property_id, integration_tenant_id, integration_property_id, correlation_id, status, local_approved_at")
    .eq("id", connectionId).maybeSingle();
  const row = result.data as ConnectionRow | null;
  if (result.error || !row) throw new Error("connection_not_found");
  return row;
}

async function requireConnectionAdmin(userDb: DbClient, connectionId: string) {
  const result = await userDb.rpc("lb01_can_manage_product_connection", { _connection_id: connectionId });
  if (result.error || result.data !== true) throw new Error("forbidden");
}

async function recordDelivery(
  admin: DbClient,
  connectionId: string,
  outcome: "accepted" | "failed" | "awaiting_peer_credential",
  actorUserId: string,
  httpStatus: number | null = null,
  errorCode: string | null = null,
) {
  const result = await admin.from("lb01_approval_delivery_attempts").insert({
    connection_id: connectionId,
    outcome,
    http_status: httpStatus,
    error_code: errorCode,
    actor_user_id: actorUserId,
  });
  if (result.error) throw new Error("delivery_audit_write_failed");
}

async function dispatchApproval(admin: DbClient, connection: ConnectionRow, actorUserId: string) {
  const result = await admin.from("lb01_peer_credentials")
    .select("peer_product, encrypted_token, encryption_iv, encryption_tag, status")
    .eq("connection_id", connection.id).maybeSingle();
  const peer = result.data as {
    peer_product: string; encrypted_token: unknown; encryption_iv: unknown;
    encryption_tag: unknown; status: string;
  } | null;
  if (result.error) throw new Error("peer_credential_lookup_failed");
  if (!peer || peer.status !== "active") {
    await recordDelivery(admin, connection.id, "awaiting_peer_credential", actorUserId);
    return { deliveryStatus: "awaiting_peer_credential" as const, connectionStatus: connection.status };
  }

  try {
    const base = validateLb01PeerBaseUrl();
    const credentialToken = decryptLb01PeerCredential({
      ciphertext: peer.encrypted_token,
      iv: peer.encryption_iv,
      tag: peer.encryption_tag,
      connectionId: connection.id,
      peerProduct: peer.peer_product,
    });
    const result = await sendLb01Approval({
      endpointUrl: new URL("/api/integrations/lb01/approval", base).toString(),
      credentialToken,
    }, connection.correlation_id);
    await recordDelivery(admin, connection.id, "accepted", actorUserId, 200);
    return { deliveryStatus: "accepted" as const, peerStatus: result.status, connectionStatus: connection.status };
  } catch {
    await recordDelivery(admin, connection.id, "failed", actorUserId, null, "peer_delivery_failed");
    return { deliveryStatus: "failed" as const, connectionStatus: connection.status };
  }
}

export const Route = createFileRoute("/api/integrations/lb01/manage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { user, client: userDb } = await authenticatedClient(request);
          const body = actionInput.parse(await request.json());
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const admin = supabaseAdmin as unknown as DbClient;

          if (body.action === "list") {
            const result = await userDb.from("staynas_product_connections")
              .select("id, integration_tenant_id, integration_property_id, local_property_id, remote_tenant_id, remote_property_id, remote_product, status, correlation_id, local_approved_at, remote_approved_at, created_at, updated_at");
            if (result.error) return Response.json({ error: "connection_list_failed" }, { status: 500 });
            return Response.json({ connections: result.data ?? [] }, { headers: { "Cache-Control": "no-store" } });
          }

          if (body.action === "create") {
            const propertyResult = await userDb.from("restaurant_properties")
              .select("id, tenant_id").eq("id", body.localPropertyId).maybeSingle();
            const property = propertyResult.data as Record<string, unknown> | null;
            if (propertyResult.error || !property) return Response.json({ error: "property_not_found" }, { status: 404 });

            const integrationTenantId = body.integrationTenantId ?? crypto.randomUUID();
            const integrationPropertyId = body.integrationPropertyId ?? crypto.randomUUID();
            const correlationId = body.correlationId ?? crypto.randomUUID();
            const requestResult = await userDb.rpc("lexibite_request_staynas_connection", {
              _integration_tenant_id: integrationTenantId,
              _integration_property_id: integrationPropertyId,
              _local_tenant_id: String(property.tenant_id),
              _local_property_id: body.localPropertyId,
              _remote_tenant_id: body.remoteTenantId,
              _remote_property_id: body.remotePropertyId,
              _correlation_id: correlationId,
            });
            if (requestResult.error || typeof requestResult.data !== "string") {
              return Response.json({ error: "connection_request_failed" }, { status: 409 });
            }
            return Response.json({
              connectionId: requestResult.data,
              pairingInvitation: {
                contractVersion: "1.0.0",
                integrationTenantId,
                integrationPropertyId,
                correlationId,
                sourceProduct: "lexibite",
                sourceTenantId: String(property["tenant_id"]),
                sourcePropertyId: body.localPropertyId,
                targetProduct: "staynas",
              },
            }, { headers: { "Cache-Control": "no-store" } });
          }

          await requireConnectionAdmin(userDb, body.connectionId);
          const connection = await connectionFor(admin, body.connectionId);
          if (connection.remote_product !== "staynas") {
            return Response.json({ error: "wrong_peer_product" }, { status: 409 });
          }

          if (body.action === "issue_handoff") {
            if (!["pending", "active"].includes(connection.status)) return Response.json({ error: "connection_not_eligible" }, { status: 409 });
            const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
            const issued = await issueLb01ServiceCredential(userDb, connection.id, expiresAt);
            const encrypted = encryptLb01PeerCredential(issued.token, connection.id, connection.remote_product);
            const code = createLb01HandoffCode();
            const handoff = await admin.from("lb01_credential_handoffs").insert({
              connection_id: connection.id,
              credential_id: issued.credentialId,
              peer_product: connection.remote_product,
              correlation_id: connection.correlation_id,
              code_hash: hashLb01HandoffCode(code),
              encrypted_token: encrypted.ciphertext,
              encryption_iv: encrypted.iv,
              encryption_tag: encrypted.tag,
              expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              created_by: user.id,
            });
            if (handoff.error) {
              await userDb.rpc("lb01_revoke_product_service_credential", {
                _credential_id: issued.credentialId, _reason: "handoff_persistence_failed",
              });
              return Response.json({ error: "handoff_creation_failed" }, { status: 500 });
            }
            return Response.json({ handoffCode: code, expiresInSeconds: 900 }, {
              headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" },
            });
          }

          if (body.action === "import_handoff") {
            if (!["pending", "active"].includes(connection.status)) return Response.json({ error: "connection_not_eligible" }, { status: 409 });
            const peerBase = validateLb01PeerBaseUrl();
            const exchangeUrl = new URL("/api/integrations/lb01/credential-exchange", peerBase);
            const response = await fetch(exchangeUrl, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                code: body.code,
                correlationId: connection.correlation_id,
                requesterProduct: "lexibite",
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) return Response.json({ error: "peer_handoff_rejected" }, { status: 409 });
            const payload: unknown = await response.json();
            const token = (payload as { token?: unknown } | null)?.token;
            if (typeof token !== "string") return Response.json({ error: "invalid_peer_handoff_response" }, { status: 502 });
            const encrypted = encryptLb01PeerCredential(token, connection.id, connection.remote_product);
            const stored = await admin.from("lb01_peer_credentials").upsert({
              connection_id: connection.id,
              peer_product: connection.remote_product,
              credential_prefix: encrypted.prefix,
              encrypted_token: encrypted.ciphertext,
              encryption_iv: encrypted.iv,
              encryption_tag: encrypted.tag,
              status: "active",
              imported_at: new Date().toISOString(),
              imported_by: user.id,
              revoked_at: null,
            }, { onConflict: "connection_id" });
            if (stored.error) return Response.json({ error: "peer_credential_storage_failed" }, { status: 500 });
            if (connection.local_approved_at) {
              const delivery = await dispatchApproval(admin, connection, user.id);
              return Response.json({ imported: true, ...delivery }, { headers: { "Cache-Control": "no-store" } });
            }
            return Response.json({ imported: true }, { headers: { "Cache-Control": "no-store" } });
          }

          if (body.action === "approve") {
            if (!["pending", "active"].includes(connection.status)) return Response.json({ error: "connection_not_eligible" }, { status: 409 });
            const approval = await userDb.rpc("lexibite_approve_staynas_connection", { _connection_id: connection.id });
            if (approval.error || typeof approval.data !== "string") return Response.json({ error: "local_approval_failed" }, { status: 409 });
            const refreshed = await connectionFor(admin, connection.id);
            const delivery = await dispatchApproval(admin, refreshed, user.id);
            return Response.json({ localApprovalStatus: approval.data, ...delivery }, { headers: { "Cache-Control": "no-store" } });
          }

          if (body.action === "retry") {
            if (!connection.local_approved_at) return Response.json({ error: "local_approval_required" }, { status: 409 });
            if (!["pending", "active"].includes(connection.status)) return Response.json({ error: "connection_not_eligible" }, { status: 409 });
            return Response.json(await dispatchApproval(admin, connection, user.id), { headers: { "Cache-Control": "no-store" } });
          }

          if (body.action === "revoke") {
            const revoked = await userDb.rpc("lexibite_set_staynas_connection_state", {
              _connection_id: connection.id, _action: "revoke", _reason: body.reason ?? "Revoked by authorized administrator",
            });
            if (revoked.error) return Response.json({ error: "connection_revocation_failed" }, { status: 409 });
            return Response.json({ status: revoked.data }, { headers: { "Cache-Control": "no-store" } });
          }

          return Response.json({ error: "unsupported_action" }, { status: 400 });
        } catch (error) {
          const message = error instanceof z.ZodError ? "invalid_request"
            : error instanceof Error && error.message === "unauthorized" ? "unauthorized"
            : error instanceof Error && error.message === "forbidden" ? "forbidden"
            : "lb01_operation_failed";
          return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : message === "forbidden" ? 403 : 400 });
        }
      },
    },
  },
});
