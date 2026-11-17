import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { guestLineSchema } from "@/modules/restaurant/selforder/selforder.contracts";

const submitSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  guestName: z.string().max(160).optional(),
  lines: z.array(guestLineSchema).min(1).max(50),
  clientRequestId: z.string().min(6).max(80),
});
const statusSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  orderId: z.string().uuid(),
});

export const submitGuestCommerceOrderFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => submitSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./orders.server");
    return mod.submitGuestCommerceOrder(supabaseAdmin, data);
  });

export const guestCommerceOrderStatusFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => statusSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./orders.server");
    return mod.getGuestCommerceOrderStatus(supabaseAdmin, data);
  });
