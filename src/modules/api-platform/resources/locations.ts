/**
 * P08 — GET /api/v1/locations. Thin wrapper only: all business logic and
 * tenant/property enforcement lives in the existing
 * src/modules/restaurant/inventory/locations.server.ts's listLocations,
 * called with the credential's synthetic service-account identity so its
 * own assertTenantRead runs exactly as it does for a human caller.
 */
import { listLocations } from "@/modules/restaurant/inventory/locations.server";
import { requireScope } from "../scope.server";
import type { ResolvedCredential } from "../credentials.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiListLocations(supabaseAdmin: any, credential: ResolvedCredential) {
  requireScope(credential, "locations:read");
  return listLocations(supabaseAdmin, credential.serviceUserId, {
    tenantId: credential.tenantId,
    propertyId: credential.propertyId ?? undefined,
    storageOnly: false,
    includeInactive: false,
  });
}
