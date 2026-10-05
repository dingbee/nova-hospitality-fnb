import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { CHANNEL_TYPES } from "./channel-contracts";
import {
  listChannelDefinitions,
  listChannelProvidersForAdmin,
  upsertChannelDefinition,
} from "./channel-catalog.server";

const listSchema = z.object({ enabledOnly: z.boolean().default(true) });
const upsertSchema = z.object({
  key: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).default(""),
  providerKey: z.string().trim().min(2).max(80),
  category: z.enum(CHANNEL_TYPES),
  enabled: z.boolean(),
  sortOrder: z.number().int().min(0).max(10000),
});

export const listChannelDefinitionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listSchema.parse(d))
  .handler(async ({ data, context }) => listChannelDefinitions(context.supabase, data.enabledOnly));

export const listChannelProvidersForAdminFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listChannelProvidersForAdmin(context.supabase, context.userId));

export const upsertChannelDefinitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => upsertChannelDefinition(context.supabase, context.userId, data));
