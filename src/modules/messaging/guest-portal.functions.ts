import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const guestPortalMenuSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** Browse-only WhatsApp landing page. Scope is derived exclusively from the one-time bearer session. */
export const guestPortalMenuFn = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => guestPortalMenuSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveWhatsAppGuestPortalSession } = await import("@/modules/messaging/guest-portal-sessions.server");
    const { fetchSellableCatalog } = await import("@/modules/restaurant/sales/pos.server");

    const session = await resolveWhatsAppGuestPortalSession(supabaseAdmin, data.token);
    if (!session || session.scope !== "menu_browse") {
      throw new Error("This Guest Portal link has expired or is no longer available. Return to WhatsApp and request a new menu link.");
    }

    const [{ data: tenant, error: tenantError }, { data: location, error: locationError }, catalog] = await Promise.all([
      supabaseAdmin.from("restaurant_tenants").select("name, settings, status")
        .eq("id", session.tenantId).maybeSingle(),
      supabaseAdmin.from("restaurant_locations").select("name, status, location_type, is_storage")
        .eq("id", session.locationId).eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId).maybeSingle(),
      fetchSellableCatalog(supabaseAdmin, session.tenantId, {
        propertyId: session.propertyId,
        locationId: session.locationId,
      }),
    ]);
    if (tenantError || !tenant || tenant.status !== "active" || locationError ||
        !location || location.status !== "active" || location.is_storage ||
        !["outlet", "restaurant", "bar"].includes(location.location_type)) {
      throw new Error("This restaurant menu is not currently available.");
    }

    const settings = tenant.settings as { business?: { tradingName?: string; logoUrl?: string | null } } | null;
    const businessName = settings?.business?.tradingName?.trim() || tenant.name;
    return {
      businessName,
      logoUrl: settings?.business?.logoUrl?.trim() || null,
      outletName: location.name,
      currency: session.currency,
      categories: catalog.categories.map((category: any) => ({
        id: category.id, name: category.name, sortOrder: category.sort_order,
      })),
      items: catalog.items
        .filter((item: any) => item.available !== false && item.priceConfigured !== false && item.price !== null)
        .map((item: any) => ({
          id: item.id, name: item.name, description: item.description,
          price: item.price, currency: session.currency, imageUrl: item.image_url,
          categoryId: item.category_id,
          variants: (item.variants ?? []).map((variant: any) => ({
            id: variant.id, name: variant.name, price: variant.price, priceIsDelta: variant.price_is_delta,
          })),
        })),
    };
  });
