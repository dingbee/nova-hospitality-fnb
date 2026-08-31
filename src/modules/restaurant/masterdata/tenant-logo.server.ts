/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Restaurant business-identity logo upload/removal (GEP4) — see
 * 0023_restaurant_tenant_logos.sql for the storage bucket and its
 * tenant-write RLS policies. Mirrors menu-image.server.ts's shape closely
 * (single image, small size limit, public bucket, tenant-scoped path,
 * replace-and-cleanup-old semantics) since a tenant logo is the same kind
 * of asset as a menu photo, just one-per-tenant instead of one-per-item.
 *
 * The client never supplies a storage path: the path is always
 * {tenantId}/{filename}, where tenantId comes from a capability-checked
 * caller. logoUrl (settings.business.logoUrl) is only ever updated after a
 * successful upload — a failed upload never touches the existing logo.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { RemoveTenantLogoInput, UploadTenantLogoInput } from "./tenant-logo.contracts";

type Sb = any;

export const TENANT_LOGO_BUCKET = "restaurant-tenant-logos";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The bucket is public-read, so the public URL is a deterministic function of the path. */
function pathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/object/public/${TENANT_LOGO_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length).split("?")[0] ?? null;
}

async function loadTenantSettings(sb: Sb, tenantId: string) {
  const { data, error } = await sb
    .from("restaurant_tenants")
    .select("id, settings")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Tenant not found.");
  return data as { id: string; settings: Record<string, any> | null };
}

export async function uploadTenantLogo(sb: Sb, userId: string, input: UploadTenantLogoInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const tenant = await loadTenantSettings(sb, input.tenantId);
  const existingLogoUrl = (tenant.settings?.business?.logoUrl ?? null) as string | null;

  const buffer = Buffer.from(input.fileBase64, "base64");
  if (buffer.length === 0) throw new Error("The selected file is empty.");
  const { TENANT_LOGO_MAX_BYTES } = await import("./tenant-logo.contracts");
  if (buffer.length > TENANT_LOGO_MAX_BYTES) {
    throw new Error(
      `Logo is too large — the limit is ${(TENANT_LOGO_MAX_BYTES / (1024 * 1024)).toFixed(1)}MB.`,
    );
  }

  const extension = EXTENSION_BY_MIME[input.mimeType];
  if (!extension) throw new Error(`Unsupported image type "${input.mimeType}".`);
  // Cache-busted by timestamp so a replaced logo is never served stale from
  // a browser/CDN cache that already has the previous filename pinned.
  const path = `${input.tenantId}/${Date.now()}.${extension}`;

  const { error: uploadError } = await sb.storage
    .from(TENANT_LOGO_BUCKET)
    .upload(path, buffer, { contentType: input.mimeType, upsert: false });
  if (uploadError) throw new Error(uploadError.message);

  const { data: pub } = sb.storage.from(TENANT_LOGO_BUCKET).getPublicUrl(path);
  const logoUrl = pub.publicUrl as string;

  const settings = {
    ...(tenant.settings ?? {}),
    business: { ...(tenant.settings?.business ?? {}), logoUrl },
  };
  const { error: updateError } = await sb
    .from("restaurant_tenants")
    .update({ settings })
    .eq("id", input.tenantId);
  if (updateError) {
    // The upload succeeded but the reference couldn't be saved — remove the
    // orphaned object rather than leaving storage and settings inconsistent.
    await sb.storage.from(TENANT_LOGO_BUCKET).remove([path]);
    throw new Error(updateError.message);
  }

  // Best-effort: the new logo is live, now drop the old one.
  const previousPath = pathFromPublicUrl(existingLogoUrl);
  if (previousPath && previousPath !== path) {
    await sb.storage.from(TENANT_LOGO_BUCKET).remove([previousPath]);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.tenant.branding.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_tenant",
    entityId: input.tenantId,
    source: "restaurant-os",
    payload: { field: "logoUrl" },
  });

  return { tenantId: input.tenantId, logoUrl };
}

export async function removeTenantLogo(sb: Sb, userId: string, input: RemoveTenantLogoInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const tenant = await loadTenantSettings(sb, input.tenantId);
  const existingLogoUrl = (tenant.settings?.business?.logoUrl ?? null) as string | null;
  if (!existingLogoUrl) return { tenantId: input.tenantId, logoUrl: null };

  const settings = {
    ...(tenant.settings ?? {}),
    business: { ...(tenant.settings?.business ?? {}), logoUrl: null },
  };
  const { error: updateError } = await sb
    .from("restaurant_tenants")
    .update({ settings })
    .eq("id", input.tenantId);
  if (updateError) throw new Error(updateError.message);

  const path = pathFromPublicUrl(existingLogoUrl);
  if (path) await sb.storage.from(TENANT_LOGO_BUCKET).remove([path]);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.tenant.branding.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_tenant",
    entityId: input.tenantId,
    source: "restaurant-os",
    payload: { field: "logoUrl", removed: true },
  });

  return { tenantId: input.tenantId, logoUrl: null };
}
