/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase read model is projected before serialization. */
import { resolveWhatsAppGuestPortalSession } from "@/modules/messaging/guest-portal-sessions.server";
import { fetchSellableCatalog } from "../sales/pos.server";

type Db = any;

export async function getGuestCommercePage(admin: Db, token: string) {
  const session = await resolveWhatsAppGuestPortalSession(admin, token);
  if (!session) {
    throw new Error("This Guest Commerce link has expired or is no longer valid. Reopen the restaurant storefront.");
  }

  const [tenantResult, propertyResult, locationResult] = await Promise.all([
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
  ]);

  const bindingResult = session.sourceChannel === "whatsapp"
    ? await admin
        .from("wa_phone_number_bindings")
        .select("display_phone_number, verified_name, status")
        .eq("id", session.bindingId)
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .eq("location_id", session.locationId)
        .maybeSingle()
    : { data: null, error: null };

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
    !["outlet", "restaurant", "bar", "cafe", "store", "room_service"].includes(location.location_type) ||
    (session.sourceChannel === "whatsapp" && (!binding || binding.status !== "active"))
  ) {
    throw new Error("This restaurant storefront is no longer available. Reopen the restaurant menu.");
  }

  const settings = (tenant.settings ?? {}) as {
    business?: { tradingName?: string; logoUrl?: string | null; description?: string | null };
  };
  const business = settings.business ?? {};
  const businessName = (business.tradingName ?? "").trim() || tenant.name;
  const catalog = await fetchSellableCatalog(admin, session.tenantId, {
    propertyId: session.propertyId,
    locationId: session.locationId,
    orderType: session.orderType,
  });

  return {
    businessName,
    businessLogoUrl: business.logoUrl?.trim() || null,
    businessDescription: business.description?.trim() || null,
    propertyName: property.name,
    outletName: location.name,
    outletType: location.location_type,
    currency: session.currency,
    supportPhone: binding?.display_phone_number ?? null,
    supportVerifiedName: binding?.verified_name ?? null,
    sourceChannel: session.sourceChannel,
    orderType: session.orderType,
    canCheckout: session.orderType === "takeaway" || (session.orderType === "dine_in" && Boolean(session.tableId)),
    tableServiceUrl: session.tableId ? `/order/${session.tableId}?legacy=1` : null,
    expiresAt: session.expiresAt,
    categories: catalog.categories,
    modifierGroups: catalog.modifierGroups,
    items: catalog.items.filter(
      (item: any) => item.is_available === true &&
        item.priceConfigured === true &&
        typeof item.price === "number" &&
        Number.isFinite(item.price),
    ),
  };
}

/** WCE-03 compatibility export; the underlying session is now channel-neutral. */
export const getWhatsAppGuestPortalPage = getGuestCommercePage;
