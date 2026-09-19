/**
 * P08 — human-facing admin server functions for API credentials,
 * integrations and outbound webhooks. Thin `createServerFn` wrappers, same
 * shape as every other `*.functions.ts` in the codebase (e.g.
 * pos.functions.ts) — all authorization and business logic lives in the
 * corresponding `*.server.ts` module, gated by "tenant.manage"
 * (owner/general_manager only).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  issueCredentialSchema,
  listCredentialsSchema,
  listIntegrationsSchema,
  listWebhookDeliveriesSchema,
  registerIntegrationSchema,
  registerWebhookEndpointSchema,
  replayWebhookDeliverySchema,
  revokeCredentialSchema,
  rotateWebhookSecretSchema,
  updateIntegrationSchema,
  updateWebhookEndpointSchema,
} from "./contracts";
import { z } from "zod";

/* ---------------- Credentials ---------------- */

export const issueApiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => issueCredentialSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./credentials.server");
    return mod.issueCredential(context.supabase, context.userId, data);
  });

export const listApiCredentialsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCredentialsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./credentials.server");
    return mod.listCredentials(context.supabase, context.userId, data);
  });

export const revokeApiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => revokeCredentialSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./credentials.server");
    return mod.revokeCredential(context.supabase, context.userId, data);
  });

/* ---------------- Integration registry ---------------- */

export const registerIntegrationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => registerIntegrationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./integrations.server");
    return mod.registerIntegration(context.supabase, context.userId, data);
  });

export const listIntegrationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listIntegrationsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./integrations.server");
    return mod.listIntegrations(context.supabase, context.userId, data);
  });

export const updateIntegrationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateIntegrationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./integrations.server");
    return mod.updateIntegration(context.supabase, context.userId, data);
  });

/* ---------------- Outbound webhooks ---------------- */

export const registerWebhookEndpointFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => registerWebhookEndpointSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.registerWebhookEndpoint(context.supabase, context.userId, data);
  });

export const listWebhookEndpointsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.listWebhookEndpoints(context.supabase, context.userId, data);
  });

export const updateWebhookEndpointFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateWebhookEndpointSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.updateWebhookEndpoint(context.supabase, context.userId, data);
  });

export const rotateWebhookSecretFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rotateWebhookSecretSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.rotateWebhookSecret(context.supabase, context.userId, data);
  });

export const listWebhookDeliveriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listWebhookDeliveriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.listWebhookDeliveries(context.supabase, context.userId, data);
  });

export const replayWebhookDeliveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => replayWebhookDeliverySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./webhooks.server");
    return mod.replayWebhookDelivery(context.supabase, context.userId, data);
  });
