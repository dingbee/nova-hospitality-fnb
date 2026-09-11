import { createServerFn } from "@tanstack/react-start";
import {
  guestMobileMoneyAccountSchema,
  guestMobileMoneyStatusSchema,
  requestGuestMobileMoneyCollectionSchema,
} from "./selfmobilemoney.contracts";

/**
 * No requireSupabaseAuth — same reasoning as selfpay.functions.ts and the
 * rest of the guest surface. Scoped by tableId (an unguessable uuid), never
 * by identity. All settlement/amount logic lives in the Payment Core
 * (payments/mobilemoney/mobilemoney.server.ts) — these are thin, guest-
 * scoped entry points into it, not a second implementation.
 */
export const getGuestMobileMoneyAccountFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestMobileMoneyAccountSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("../payments/mobilemoney/mobilemoney.server");
    return mod.getGuestMobileMoneyAccount(supabaseAdmin, data);
  });

export const requestGuestMobileMoneyCollectionFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => requestGuestMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("../payments/mobilemoney/mobilemoney.server");
    return mod.requestGuestMobileMoneyCollection(supabaseAdmin, data);
  });

export const getGuestMobileMoneyStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestMobileMoneyStatusSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("../payments/mobilemoney/mobilemoney.server");
    return mod.getGuestMobileMoneyStatus(supabaseAdmin, data);
  });
