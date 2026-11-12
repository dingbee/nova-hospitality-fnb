import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

type Result = { data: unknown; error: { message?: string } | null };
type Query = PromiseLike<Result> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: Record<string, unknown>): Query;
  maybeSingle(): Promise<Result>;
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }): Promise<Result>;
  update(values: Record<string, unknown>): Query;
};
type Db = {
  rpc(name: string, args: Record<string, unknown>): Promise<Result>;
  from(table: string): Query;
};

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), connectionId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("save"), connectionId: z.string().uuid(), outletId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(120), outletType: z.string().trim().min(1).max(48),
    publicDescription: z.string().max(1000).nullable().optional(),
    guestVisibleStatus: z.enum(["unpublished", "open", "closed", "temporarily_unavailable"]),
    serviceHours: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({ action: z.literal("approve"), connectionId: z.string().uuid(), mappingId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("revoke"), connectionId: z.string().uuid(), mappingId: z.string().uuid() }).strict(),
]);

async function userClient(request: Request) {
  const match = /^Bearer\\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new Error("unauthorized");
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("configuration_missing");
  const client = createClient<Database>(url, key, {
    global: { headers: { Authorization: "Bearer " + match[1] } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data.user) throw new Error("unauthorized");
  return { user: data.user, db: client as unknown as Db };
}

export const Route = createFileRoute("/api/integrations/lb02/outlets")({
  server: { handlers: {
    POST: async ({ request }) => {
      try {
        const { user, db } = await userClient(request);
        const body = input.parse(await request.json());
        const permission = await db.rpc("lb01_can_manage_product_connection", { _connection_id: body.connectionId });
        if (permission.error || permission.data !== true) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as Db;
        const connectionResult = await admin.from("staynas_product_connections")
          .select("id,remote_product,status,local_tenant_id,local_property_id,integration_property_id,remote_property_id,local_approved_at,remote_approved_at")
          .eq("id", body.connectionId).maybeSingle();
        const connection = connectionResult.data as Record<string, unknown> | null;
        if (connectionResult.error || !connection || connection.remote_product !== "staynas"
          || connection.status !== "active" || !connection.local_approved_at || !connection.remote_approved_at) {
          return Response.json({ error: "active_mutually_approved_connection_required" }, { status: 409 });
        }
        if (body.action === "list") {
          const rows = await admin.from("lb02_outlet_property_mappings")
            .select("id,local_outlet_id,display_name,outlet_type,public_description,guest_visible_status,published_service_hours,approval_status,approved_at,source_version,outlet_reference")
            .eq("connection_id", body.connectionId).order("created_at", { ascending: true });
          if (rows.error) throw new Error("mapping_list_failed");
          return Response.json({ mappings: rows.data ?? [] }, { headers: { "Cache-Control": "no-store" } });
        }
        if (body.action === "save") {
          const result = await admin.from("lb02_outlet_property_mappings").upsert({
            connection_id: connection.id,
            local_tenant_id: connection.local_tenant_id,
            local_property_id: connection.local_property_id,
            local_outlet_id: body.outletId,
            integration_property_id: connection.integration_property_id,
            remote_property_id: connection.remote_property_id,
            display_name: body.displayName,
            outlet_type: body.outletType,
            public_description: body.publicDescription ?? null,
            guest_visible_status: body.guestVisibleStatus,
            published_service_hours: body.serviceHours,
            approval_status: "pending",
            approved_by: null,
            approved_at: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "connection_id,local_outlet_id" });
          if (result.error) return Response.json({ error: "mapping_save_rejected" }, { status: 422 });
          return Response.json({ saved: true, approvalStatus: "pending" }, { headers: { "Cache-Control": "no-store" } });
        }
        const changes = body.action === "approve"
          ? { approval_status: "approved", approved_by: user.id, approved_at: new Date().toISOString() }
          : { approval_status: "revoked", approved_by: null, approved_at: null, guest_visible_status: "unpublished" };
        const updated = await admin.from("lb02_outlet_property_mappings").update(changes)
          .eq("id", body.mappingId).eq("connection_id", body.connectionId);
        if (updated.error) return Response.json({ error: "mapping_status_update_failed" }, { status: 422 });
        return Response.json({ updated: true, approvalStatus: body.action === "approve" ? "approved" : "revoked" },
          { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof z.ZodError) return Response.json({ error: "invalid_request" }, { status: 400 });
        const message = error instanceof Error ? error.message : "";
        return Response.json({ error: message === "unauthorized" ? "unauthorized" : "lb02_outlet_operation_failed" },
          { status: message === "unauthorized" ? 401 : 400 });
      }
    },
  } },
});
