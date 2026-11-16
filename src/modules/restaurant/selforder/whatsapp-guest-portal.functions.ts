import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const tokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** Public guest read: the opaque token is resolved server-side; internal scope IDs are never serialized. */
export const whatsappGuestPortalPageFn = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => tokenSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./whatsapp-guest-portal.server");
    return mod.getWhatsAppGuestPortalPage(supabaseAdmin, data.token);
  });
