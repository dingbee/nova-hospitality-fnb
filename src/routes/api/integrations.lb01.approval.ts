import { createFileRoute } from "@tanstack/react-router";
import { authenticateLb01ServiceRequest } from "@/modules/api-platform/lb01.credentials.server";

/**
 * LB-01 receiver: accept remote approval only after credential verification,
 * HMAC validation and durable nonce consumption. Mapping identity is derived
 * from the authenticated local connection, never from request-supplied IDs.
 */
export const Route = createFileRoute("/api/integrations/lb01/approval")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let authenticated: Awaited<ReturnType<typeof authenticateLb01ServiceRequest>>;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          authenticated = await authenticateLb01ServiceRequest(supabaseAdmin, request);
        } catch {
          return Response.json({ error: "Unauthorized integration request." }, { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid approval payload." }, { status: 400 });
        }
        const correlationId = (body as { correlationId?: unknown } | null)?.correlationId;
        const connection = authenticated.connection;
        if (typeof correlationId !== "string" || correlationId !== connection.correlation_id
          || connection.remote_product !== "staynas") {
          return Response.json({ error: "Approval does not match the authenticated connection." }, { status: 403 });
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error } = await supabaseAdmin.rpc("lexibite_record_staynas_approval", {
            _integration_tenant_id: connection.integration_tenant_id,
            _integration_property_id: connection.integration_property_id,
            _remote_tenant_id: connection.remote_tenant_id,
            _remote_property_id: connection.remote_property_id,
            _correlation_id: connection.correlation_id,
          });
          if (error || !["pending", "active"].includes(String(data))) {
            return Response.json({ error: "Connection approval could not be recorded." }, { status: 409 });
          }
          return Response.json({ accepted: true, status: data, correlationId });
        } catch {
          return Response.json({ error: "Connection approval could not be recorded." }, { status: 500 });
        }
      },
    },
  },
});
