/**
 * P08 — GET /api/v1/menus and GET /api/v1/menus/:menuId/items. Thin
 * wrappers over the existing src/modules/restaurant/menu/menu.server.ts —
 * no menu business logic lives here.
 */
import { listMenuItems, listMenus } from "@/modules/restaurant/menu/menu.server";
import { assertCredentialCoversProperty, requireScope } from "../scope.server";
import { ApiError } from "../errors";
import type { ResolvedCredential } from "../credentials.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiListMenus(supabaseAdmin: any, credential: ResolvedCredential) {
  requireScope(credential, "menus:read");
  return listMenus(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    propertyId: credential.propertyId ?? undefined,
    status: "published",
    limit: 100,
  });
}

export async function apiListMenuItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseAdmin: any,
  credential: ResolvedCredential,
  input: { menuId?: string; limit: number },
) {
  requireScope(credential, "menus:read");
  // Object-level authorization: `apiListMenus` (the collection endpoint)
  // filters by the credential's own property, but a menuId is an opaque
  // object reference a caller supplies directly — the property scope must
  // be re-checked against the referenced menu's OWN property, exactly like
  // resources/orders.ts does for a single order, or a property-scoped
  // credential could read another property's menu items by ID substitution.
  if (input.menuId) {
    const { data: menu } = await supabaseAdmin
      .from("restaurant_menus")
      .select("id, property_id")
      .eq("tenant_id", credential.tenantId)
      .eq("id", input.menuId)
      .maybeSingle();
    if (!menu) throw new ApiError("not_found", "Menu not found.");
    assertCredentialCoversProperty(credential, menu.property_id ?? null);
  }
  return listMenuItems(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    menuId: input.menuId,
    limit: input.limit,
  });
}
