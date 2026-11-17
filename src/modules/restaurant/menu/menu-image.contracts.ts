import { z } from "zod";

const uuid = z.string().uuid();

export const MENU_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MenuImageMimeType = (typeof MENU_IMAGE_MIME_TYPES)[number];

/** Matches the storage bucket's own file_size_limit (0009_menu_item_images.sql). */
export const MENU_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const uploadMenuItemImageSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
  mimeType: z.enum(MENU_IMAGE_MIME_TYPES),
  /** Base64-encoded file body. Bounded generously above the byte limit to allow for encoding overhead. */
  fileBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MENU_IMAGE_MAX_BYTES * 4) / 3) + 1024),
});
export type UploadMenuItemImageInput = z.infer<typeof uploadMenuItemImageSchema>;

export const removeMenuItemImageSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
});
export type RemoveMenuItemImageInput = z.infer<typeof removeMenuItemImageSchema>;

/** Client-side mirror of the server's MIME/size checks — same limits, earlier feedback. */
export function validateMenuImageFile(file: File): string | null {
  if (!(MENU_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "Use a JPEG, PNG or WebP image.";
  }
  if (file.size > MENU_IMAGE_MAX_BYTES) {
    return `Image is too large — the limit is ${Math.floor(MENU_IMAGE_MAX_BYTES / (1024 * 1024))}MB.`;
  }
  return null;
}
