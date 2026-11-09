
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptLb01PeerCredential } from "@/modules/api-platform/lb01.handoff.server";

const inputSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  correlationId: z.string().min(8).max(128),
  requesterProduct: z.literal("staynas"),
}).strict();

type DbResult = { data: unknown; error: unknown };
type DbQuery = PromiseLike<DbResult> & {
  select(columns: string): DbQuery;
  eq(column: string, value: unknown): DbQuery;
  maybeSingle(): Promise<DbResult>;
};
type DbClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<DbResult>;
  from(table: string): DbQuery;
};

export const Route = createFileRoute("/api/integrations/lb01/credential-exchange")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const raw = await request.text();
          if (raw.length > 2048) return Response.json({ error: "invalid_request" }, { status: 413 });
          const body = inputSchema.parse(JSON.parse(raw));
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const admin = supabaseAdmin as unknown as DbClient;
          const codeHash = "\\x" + createHash("sha256").update(body.code, "utf8").digest("hex");
          const consumed = await admin.rpc("lb01_consume_credential_handoff", {
            _code_hash: codeHash,
            _requester_product: body.requesterProduct,
            _correlation_id: body.correlationId,
          });
          if (consumed.error) return Response.json({ error: "handoff_unavailable" }, { status: 503 });
          const rows = Array.isArray(consumed.data) ? consumed.data : consumed.data ? [consumed.data] : [];
          const row = rows[0] as {
            connection_id?: unknown;
            credential_prefix?: unknown;
            encrypted_token?: unknown;
            encryption_iv?: unknown;
            encryption_tag?: unknown;
          } | undefined;
          if (!row || typeof row.connection_id !== "string" || typeof row.credential_prefix !== "string") {
            return Response.json({ error: "handoff_invalid_or_expired" }, { status: 404 });
          }
          const mappingResult = await admin.from("staynas_product_connections")
            .select("integration_tenant_id, integration_property_id, local_tenant_id, local_property_id, remote_tenant_id, remote_property_id, remote_product, status, correlation_id")
            .eq("id", row.connection_id).maybeSingle();
          const mapping = mappingResult.data as Record<string, unknown> | null;
          if (mappingResult.error || !mapping || mapping.status !== "pending" && mapping.status !== "active"
            || mapping.remote_product !== "staynas") {
            return Response.json({ error: "handoff_mapping_unavailable" }, { status: 404 });
          }
          const token = decryptLb01PeerCredential({
            ciphertext: row.encrypted_token,
            iv: row.encryption_iv,
            tag: row.encryption_tag,
            connectionId: row.connection_id,
            peerProduct: "lexibite",
          });
          if (!token.startsWith("lb01_v1_" + row.credential_prefix + "_")) {
            return Response.json({ error: "handoff_integrity_failed" }, { status: 500 });
          }
          return Response.json({
            token,
            integrationTenantId: mapping.integration_tenant_id,
            integrationPropertyId: mapping.integration_property_id,
            correlationId: mapping.correlation_id,
            issuerTenantId: mapping["local_tenant_id"],
            issuerPropertyId: mapping.local_property_id,
            targetTenantId: mapping.remote_tenant_id,
            targetPropertyId: mapping.remote_property_id,
            peerProduct: body.requesterProduct,
          }, {
            headers: {
              "Cache-Control": "no-store, private, max-age=0",
              Pragma: "no-cache",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof z.ZodError ? "invalid_request" : "handoff_unavailable" },
            { status: 400 },
          );
        }
      },
    },
  },
});
