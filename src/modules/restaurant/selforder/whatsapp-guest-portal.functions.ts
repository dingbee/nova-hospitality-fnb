import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const tokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const publicStoreSchema = z.object({
  tenantSlug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
  locationSlug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
});
const tableSchema = z.object({ tableId: z.string().uuid() });

/** Channel-neutral public guest read. Internal scope IDs are never serialized. */
export const guestCommercePageFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => tokenSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./whatsapp-guest-portal.server");
    return mod.getGuestCommercePage(supabaseAdmin, data.token);
  });

/** WCE-03 compatibility alias. */
export const whatsappGuestPortalPageFn = guestCommercePageFn;

export const createWebsiteGuestCommerceSessionFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => publicStoreSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("@/modules/messaging/guest-portal-sessions.server");
    return mod.createGuestCommerceSessionForPublicStore(supabaseAdmin, {
      ...data,
      sourceChannel: "website",
    });
  });

export const createSocialGuestCommerceSessionFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => publicStoreSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("@/modules/messaging/guest-portal-sessions.server");
    return mod.createGuestCommerceSessionForPublicStore(supabaseAdmin, {
      ...data,
      sourceChannel: "social",
    });
  });

export const createDirectGuestCommerceSessionFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => publicStoreSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("@/modules/messaging/guest-portal-sessions.server");
    return mod.createGuestCommerceSessionForPublicStore(supabaseAdmin, {
      ...data,
      sourceChannel: "direct",
    });
  });

export const createQrGuestCommerceSessionFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => tableSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("@/modules/messaging/guest-portal-sessions.server");
    return mod.createGuestCommerceSessionForTable(supabaseAdmin, data.tableId);
  });
