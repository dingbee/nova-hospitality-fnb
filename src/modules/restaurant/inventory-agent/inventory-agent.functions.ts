import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  executeApprovedInventoryAgentActions,
  runInventoryAgent,
  verifyExecutedInventoryAgentActions,
} from "./inventory-agent.server";

const baseSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

const runSchema = baseSchema.extend({
  windowDays: z.number().int().min(7).max(120).default(30),
});

const sweepSchema = baseSchema.extend({
  limit: z.number().int().min(1).max(50).default(20),
});

/** Observe → reason → recommend. No operational write beyond canonical decision persistence. */
export const runInventoryAgentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runSchema.parse(d))
  .handler(async ({ data, context }) =>
    runInventoryAgent(context.supabase, context.userId, data),
  );

/** Execute only already-approved Inventory Agent actions. Never approves. */
export const executeApprovedInventoryAgentActionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => sweepSchema.parse(d))
  .handler(async ({ data, context }) =>
    executeApprovedInventoryAgentActions(context.supabase, context.userId, data),
  );

/** Independently verify executed Inventory Agent actions. */
export const verifyExecutedInventoryAgentActionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => sweepSchema.parse(d))
  .handler(async ({ data, context }) =>
    verifyExecutedInventoryAgentActions(context.supabase, context.userId, data),
  );
