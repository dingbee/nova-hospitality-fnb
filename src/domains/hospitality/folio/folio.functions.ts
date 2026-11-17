import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { folioPostingStatusSchema, folioStayLookupSchema, folioValidateSchema } from "./folio.contracts";

export const findChargeableStaysFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => folioStayLookupSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./folioAdapter.server");
    return mod.findChargeableStays(context.supabase, context.userId, data);
  });

export const validateRoomChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => folioValidateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./folioAdapter.server");
    return mod.validateRoomCharge(context.supabase, context.userId, data);
  });

export const folioPostingStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => folioPostingStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./folioAdapter.server");
    return mod.getFolioPostingStatus(context.supabase, context.userId, data);
  });
