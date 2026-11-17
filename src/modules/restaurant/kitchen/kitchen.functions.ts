import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  advanceTicketSchema,
  fireOrderSchema,
  listStationsSchema,
  listTicketsSchema,
  upsertStationSchema,
} from "../core/contracts";

export const listRestaurantStationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listStationsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.listStations(context.supabase, context.userId, data);
  });

export const upsertRestaurantStationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertStationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.upsertStation(context.supabase, context.userId, data);
  });

export const listRestaurantKitchenTicketsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listTicketsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.listTickets(context.supabase, context.userId, data);
  });

export const fireRestaurantOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => fireOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.fireOrder(context.supabase, context.userId, data);
  });

export const advanceRestaurantTicketFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => advanceTicketSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.advanceTicket(context.supabase, context.userId, data);
  });

export const restaurantStationPerformanceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ tenantId: z.string().uuid(), since: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.stationPerformance(context.supabase, context.userId, data.tenantId, data.since);
  });
