import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({ tenantId: z.string().uuid(), menuItemId: z.string().uuid() });

export const menuItemCompositionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => schema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./composition.server");
    return mod.getMenuItemComposition(context.supabase, context.userId, data);
  });
