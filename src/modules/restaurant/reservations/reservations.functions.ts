import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCapability } from "@/modules/restaurant/core/access.server";

const reservationScopeSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export const listGuestReservationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => reservationScopeSchema.parse(value))
  .handler(async ({ data, context }) => {
    await assertCapability(context.supabase, context.userId, data.tenantId, "reservation.manage", {
      propertyId: data.propertyId,
    });
    const { data: reservations, error } = await context.supabase
      .from("restaurant_table_reservations")
      .select(
        "id, booking_reference, guest_name, guest_phone_e164, party_size, starts_at, ends_at, status, table_id, source, notes, restaurant_tables(code, name)",
      )
      .eq("tenant_id", data.tenantId)
      .eq("property_id", data.propertyId)
      .eq("location_id", data.locationId)
      .gte("starts_at", data.from)
      .lt("starts_at", data.to)
      .order("starts_at", { ascending: true });
    if (error) throw new Error("Guest reservations could not be loaded.");
    return reservations ?? [];
  });

const updateReservationStatusSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid(),
  reservationId: z.string().uuid(),
  status: z.enum(["confirmed", "seated", "completed", "cancelled", "no_show"]),
});

export const updateGuestReservationStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => updateReservationStatusSchema.parse(value))
  .handler(async ({ data, context }) => {
    await assertCapability(context.supabase, context.userId, data.tenantId, "reservation.manage", {
      propertyId: data.propertyId,
    });
    const { data: reservation, error } = await context.supabase
      .from("restaurant_table_reservations")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("id", data.reservationId)
      .eq("tenant_id", data.tenantId)
      .eq("property_id", data.propertyId)
      .eq("location_id", data.locationId)
      .select("id, table_id")
      .maybeSingle();
    if (error || !reservation) throw new Error("The reservation status could not be updated.");

    if (reservation.table_id && data.status === "seated") {
      await context.supabase
        .from("restaurant_tables")
        .update({ status: "occupied" })
        .eq("id", reservation.table_id)
        .eq("tenant_id", data.tenantId)
        .eq("property_id", data.propertyId)
        .eq("location_id", data.locationId);
    }
    if (reservation.table_id && ["completed", "cancelled", "no_show"].includes(data.status)) {
      const { data: openOrders } = await context.supabase
        .from("restaurant_orders")
        .select("id")
        .eq("tenant_id", data.tenantId)
        .eq("property_id", data.propertyId)
        .eq("location_id", data.locationId)
        .eq("table_id", reservation.table_id)
        .in("status", ["open", "sent", "served"])
        .limit(1);
      if (!openOrders?.length) {
        await context.supabase
          .from("restaurant_tables")
          .update({ status: "available" })
          .eq("id", reservation.table_id)
          .eq("tenant_id", data.tenantId)
          .eq("property_id", data.propertyId)
          .eq("location_id", data.locationId);
      }
    }
    return { updated: true as const, status: data.status };
  });
