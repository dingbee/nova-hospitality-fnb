import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateLb01ServiceRequest } from "@/modules/api-platform/lb01.credentials.server";

const schema = z.object({
  sourceEventId: z.string().uuid(),
  eventType: z.literal("guest.stay_status_changed.v1"),
  eventVersion: z.literal(1),
  integrationPropertyId: z.string().uuid(),
  aggregateId: z.string().uuid(),
  aggregateVersion: z.number().int().positive(),
  correlationId: z.string().min(8).max(128),
  idempotencyKey: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
}).strict();

type Admin = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
};

export const Route = createFileRoute("/api/integrations/lb02/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (Number(request.headers.get("content-length") ?? 0) > 16_384) {
          return Response.json({ error: "payload_too_large" }, { status: 413 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as Admin;
        try {
          const { connection } = await authenticateLb01ServiceRequest(admin, request);
          if (connection.remote_product !== "staynas" || connection.status !== "active") {
            return Response.json({ error: "connection_not_active" }, { status: 403 });
          }
          const body = schema.parse(await request.json());
          if (body.integrationPropertyId !== connection.integration_property_id
            || body.correlationId !== connection.correlation_id) {
            return Response.json({ error: "connection_scope_mismatch" }, { status: 403 });
          }
          const { data, error } = await admin.rpc("lb02_apply_stay_status_event", {
            _connection_id: connection.id,
            _source_event_id: body.sourceEventId,
            _event_type: body.eventType,
            _event_version: body.eventVersion,
            _integration_property_id: body.integrationPropertyId,
            _aggregate_id: body.aggregateId,
            _aggregate_version: body.aggregateVersion,
            _correlation_id: body.correlationId,
            _idempotency_key: body.idempotencyKey,
            _payload: body.payload,
          });
          if (error) return Response.json({ error: "event_rejected", code: "invalid_or_out_of_scope_event" }, { status: 422 });
          return Response.json({ accepted: true, outcome: data }, {
            headers: { "Cache-Control": "no-store, private, max-age=0" },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid_request";
          const denied = message.includes("Unauthorized") || message.includes("Replay");
          return Response.json({ error: denied ? "unauthorized" : "invalid_request" }, { status: denied ? 401 : 400 });
        }
      },
    },
  },
});
