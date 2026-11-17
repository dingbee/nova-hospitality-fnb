import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCapability } from "@/modules/restaurant/core/access.server";

/** Tests the encrypted property integration without exposing credentials or creating a payment. */
export const testPesapalIntegrationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ tenantId: z.string().uuid(), propertyId: z.string().uuid() }).parse(value),
  )
  .handler(async ({ data, context }) => {
    await assertCapability(context.supabase, context.userId, data.tenantId, "tenant.manage", {
      propertyId: data.propertyId,
    });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getConfiguredProvider } = await import("@/modules/restaurant/selforder/selfpay.server");
    const provider = await getConfiguredProvider(supabaseAdmin, data.tenantId, data.propertyId);
    if (!provider?.testConnection) {
      throw new Error("No active Pesapal payment integration is configured for this property.");
    }
    await provider.testConnection();
    return { ok: true as const, provider: "pesapal" as const };
  });
