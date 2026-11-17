import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { removeTenantLogoSchema, uploadTenantLogoSchema } from "./tenant-logo.contracts";

export const uploadTenantLogoFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadTenantLogoSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./tenant-logo.server");
    return mod.uploadTenantLogo(context.supabase, context.userId, data);
  });

export const removeTenantLogoFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => removeTenantLogoSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./tenant-logo.server");
    return mod.removeTenantLogo(context.supabase, context.userId, data);
  });
