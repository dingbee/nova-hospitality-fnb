import { z } from "zod";

const uuid = z.string().uuid();

/**
 * SVG is deliberately excluded — see 0023_restaurant_tenant_logos.sql for
 * why (public bucket, no Content-Disposition override, embedded <script>
 * risk if the object URL is opened directly). Same jpeg/png/webp-only
 * restriction as restaurant-menu-images (menu-image.contracts.ts).
 */
export const TENANT_LOGO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type TenantLogoMimeType = (typeof TENANT_LOGO_MIME_TYPES)[number];

/** Matches the storage bucket's own file_size_limit (0023_restaurant_tenant_logos.sql). */
export const TENANT_LOGO_MAX_BYTES = 1.5 * 1024 * 1024;

export const uploadTenantLogoSchema = z.object({
  tenantId: uuid,
  mimeType: z.enum(TENANT_LOGO_MIME_TYPES),
  /** Base64-encoded file body. Bounded generously above the byte limit to allow for encoding overhead. */
  fileBase64: z
    .string()
    .min(1)
    .max(Math.ceil((TENANT_LOGO_MAX_BYTES * 4) / 3) + 1024),
});
export type UploadTenantLogoInput = z.infer<typeof uploadTenantLogoSchema>;

export const removeTenantLogoSchema = z.object({ tenantId: uuid });
export type RemoveTenantLogoInput = z.infer<typeof removeTenantLogoSchema>;

/** Client-side mirror of the server's MIME/size checks — same limits, earlier feedback. */
export function validateTenantLogoFile(file: File): string | null {
  if (!(TENANT_LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "Use a JPEG, PNG or WebP image.";
  }
  if (file.size > TENANT_LOGO_MAX_BYTES) {
    return `Logo is too large — the limit is ${(TENANT_LOGO_MAX_BYTES / (1024 * 1024)).toFixed(1)}MB.`;
  }
  return null;
}
