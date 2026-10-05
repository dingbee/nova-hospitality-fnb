import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  createChannelConnectionSchema,
  listChannelConnectionsSchema,
  testChannelConnectionSchema,
  updateChannelConnectionSchema,
} from "./channel-contracts";
import {
  createChannelConnection,
  listChannelConnections,
  testChannelConnectionForTenant,
  updateChannelConnection,
} from "./channel.server";

export const listChannelConnectionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listChannelConnectionsSchema.parse(d))
  .handler(async ({ data, context }) => listChannelConnections(context.supabase, context.userId, data));

export const createChannelConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createChannelConnectionSchema.parse(d))
  .handler(async ({ data, context }) => createChannelConnection(context.supabase, context.userId, data));

export const updateChannelConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateChannelConnectionSchema.parse(d))
  .handler(async ({ data, context }) => updateChannelConnection(context.supabase, context.userId, data));

export const testChannelConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => testChannelConnectionSchema.parse(d))
  .handler(async ({ data, context }) => testChannelConnectionForTenant(context.userId, data));
