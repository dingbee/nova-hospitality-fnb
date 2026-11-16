/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase read model is projected before serialization. */
import { resolveWhatsAppGuestPortalSession } from "@/modules/messaging/guest-portal-sessions.server";
import { fetchSellableCatalog } from "../sales/pos.server";

type Db = any;

export async function getWhatsAppGuestPortalPage(admin: Db, token: string) {
  const session = await resolveWhatsAppGuestPortalSession(admin, token);
  if (!session) {
    throw new Error("This Guest Portal link has expired or is no longer valid. Request a new link on WhatsApp.");
  }

  const [tenantResult, propertyResult, locationResult, bindingResult] = await Promise.all([
    admin
      .from("restaurant_tenants")
      .select("id, name, status, settings")
      .eq("id", session.tenantId)
      .maybeSingle(),
    admin
      .from("restaurant_properties")
      .select("id, name, currency")
      .eq("id", session.propertyId)
      .eq("tenant_id", session.tenantId)
      .maybeSingle(),
    admin
      .from("restaurant_locations")
      .select("id, name, location_type, is_storage, status")
      .eq("id", session.locationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .maybeSingle(),
    admin
      .from("wa_phone_number_bindings")
      .select("display_phone_number, verified_name, status")
      .eq("id", session.bindingId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .eq("location_id", session.locationId)
      .maybeSingle(),
  ]);

  const tenant = tenantResult.data;
  const property = propertyResult.data;
  const location = locationResult.data;
  const binding = bindingResult.data;
  if (
    !tenant ||
    tenant.status !== "active" ||
    !property ||
    !property.currency ||
    String(property.currency).toUpperCase() !== session.currency ||
    !location ||
    location.status !== "active" ||
    location.is_storage ||
    !["outlet", "restaurant", "bar"].includes(location.location_type) ||
    !binding ||
    binding.status !== "active"
  ) {
    throw new Error("This restaurant ordering link is no longer available. Request a fresh link on WhatsApp.");
  }

  const settings = (tenant.settings ?? {}) as {
    business?: { tradingName?: string; logoUrl?: string | null; description?: string | null };
  };
  const business = settings.business ?? {};
  const businessName = (business.tradingName ?? "").trim() || tenant.name;
  const catalog = await fetchSellableCatalog(admin, session.tenantId, {
    propertyId: session.propertyId,
    locationId: session.locationId,
  });

  return {
    businessName,
    businessLogoUrl: business.logoUrl?.trim() || null,
    businessDescription: business.description?.trim() || null,
    propertyName: property.name,
    outletName: location.name,
    outletType: location.location_type,
    currency: session.currency,
    supportPhone: binding.display_phone_number ?? null,
    supportVerifiedName: binding.verified_name ?? null,
    expiresAt: session.expiresAt,
    categories: catalog.categories,
    items: catalog.items.filter(
      (item: any) => item.available !== false && item.priceConfigured !== false && item.price !== null,
    ),
  };
}
