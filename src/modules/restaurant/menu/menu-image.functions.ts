import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { removeMenuItemImageSchema, uploadMenuItemImageSchema } from "./menu-image.contracts";

export const uploadMenuItemImageFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadMenuItemImageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu-image.server");
    return mod.uploadMenuItemImage(context.supabase, context.userId, data);
  });

export const removeMenuItemImageFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => removeMenuItemImageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu-image.server");
    return mod.removeMenuItemImage(context.supabase, context.userId, data);
  });
