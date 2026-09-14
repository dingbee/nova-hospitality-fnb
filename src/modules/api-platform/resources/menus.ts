/**
 * P08 — GET /api/v1/menus and GET /api/v1/menus/:menuId/items. Thin
 * wrappers over the existing src/modules/restaurant/menu/menu.server.ts —
 * no menu business logic lives here.
 */
import { listMenuItems, listMenus } from "@/modules/restaurant/menu/menu.server";
import { requireScope } from "../scope.server";
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
  return listMenuItems(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    menuId: input.menuId,
    limit: input.limit,
  });
}
