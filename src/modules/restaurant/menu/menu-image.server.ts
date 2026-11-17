/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Menu item image upload/removal — see 0009_menu_item_images.sql for the
 * storage bucket and its tenant-write RLS policies.
 *
 * The client never supplies a storage path or a tenant id it controls: the
 * path is always {tenantId}/{menuItemId}/{filename}, where tenantId comes
 * from a capability-checked caller and menuItemId is verified to actually
 * belong to that tenant before anything is written. image_url is only ever
 * updated after a successful upload — a failed upload never touches the
 * existing reference.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  MENU_IMAGE_MAX_BYTES,
  type RemoveMenuItemImageInput,
  type UploadMenuItemImageInput,
} from "./menu-image.contracts";

type Sb = any;

export const MENU_IMAGE_BUCKET = "restaurant-menu-images";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The bucket is public-read, so the public URL is a deterministic function of the path. */
function pathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/object/public/${MENU_IMAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length).split("?")[0] ?? null;
}

async function loadOwnedMenuItem(sb: Sb, tenantId: string, menuItemId: string) {
  const { data, error } = await sb
    .from("restaurant_menu_items")
    .select("id, image_url")
    .eq("id", menuItemId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Menu item not found for this tenant.");
  return data as { id: string; image_url: string | null };
}

export async function uploadMenuItemImage(sb: Sb, userId: string, input: UploadMenuItemImageInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const item = await loadOwnedMenuItem(sb, input.tenantId, input.menuItemId);

  const buffer = Buffer.from(input.fileBase64, "base64");
  if (buffer.length === 0) throw new Error("The selected file is empty.");
  if (buffer.length > MENU_IMAGE_MAX_BYTES) {
    throw new Error(
      `Image is too large — the limit is ${Math.floor(MENU_IMAGE_MAX_BYTES / (1024 * 1024))}MB.`,
    );
  }

  const extension = EXTENSION_BY_MIME[input.mimeType];
  if (!extension) throw new Error(`Unsupported image type "${input.mimeType}".`);
  const path = `${input.tenantId}/${input.menuItemId}/${Date.now()}.${extension}`;

  const { error: uploadError } = await sb.storage
    .from(MENU_IMAGE_BUCKET)
    .upload(path, buffer, { contentType: input.mimeType, upsert: false });
  if (uploadError) throw new Error(uploadError.message);

  const { data: pub } = sb.storage.from(MENU_IMAGE_BUCKET).getPublicUrl(path);
  const imageUrl = pub.publicUrl as string;

  const { error: updateError } = await sb
    .from("restaurant_menu_items")
    .update({ image_url: imageUrl, updated_at: new Date().toISOString() })
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId);
  if (updateError) {
    // The upload succeeded but the reference couldn't be saved — remove the
    // orphaned object rather than leaving storage and image_url inconsistent.
    await sb.storage.from(MENU_IMAGE_BUCKET).remove([path]);
    throw new Error(updateError.message);
  }

  // Best-effort: the new image is live, now drop the old one.
  const previousPath = pathFromPublicUrl(item.image_url);
  if (previousPath && previousPath !== path) {
    await sb.storage.from(MENU_IMAGE_BUCKET).remove([previousPath]);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.menu.item.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: item.id,
    source: "restaurant-os",
    payload: { field: "image_url" },
  });

  return { id: item.id, imageUrl };
}

export async function removeMenuItemImage(sb: Sb, userId: string, input: RemoveMenuItemImageInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const item = await loadOwnedMenuItem(sb, input.tenantId, input.menuItemId);
  if (!item.image_url) return { id: item.id, imageUrl: null };

  const { error: updateError } = await sb
    .from("restaurant_menu_items")
    .update({ image_url: null, updated_at: new Date().toISOString() })
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId);
  if (updateError) throw new Error(updateError.message);

  const path = pathFromPublicUrl(item.image_url);
  if (path) await sb.storage.from(MENU_IMAGE_BUCKET).remove([path]);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.menu.item.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: item.id,
    source: "restaurant-os",
    payload: { field: "image_url", removed: true },
  });

  return { id: item.id, imageUrl: null };
}
