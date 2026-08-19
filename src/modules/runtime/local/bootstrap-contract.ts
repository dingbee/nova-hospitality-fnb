/**
 * First-run tenant + administrator provisioning contract
 * (PRODUCTIZATION-3, Phase 6). Client-safe: no secrets, no node APIs.
 */
import { z } from "zod";

export const bootstrapRequestSchema = z.object({
  property: z.object({
    name: z.string().min(2).max(120),
    legalName: z.string().max(160).optional(),
    country: z.string().length(2, "ISO 3166-1 alpha-2 country code"),
    currency: z.string().length(3, "ISO 4217 currency code"),
    timezone: z.string().min(3).max(64),
  }),
  outlet: z.object({
    name: z.string().min(2).max(120),
    type: z.enum(["restaurant", "bar"]).default("restaurant"),
  }),
  administrator: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(10).max(200),
  }),
});

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export type BootstrapResponse =
  | {
      status: "bootstrapped" | "already_bootstrapped";
      tenantId: string;
      propertyId?: string;
      locationId?: string;
      adminUserId: string;
    }
  | { status: "refused"; reason: string };

export function tenantSlugFrom(propertyName: string): string {
  return propertyName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Replay protection. The fingerprint is derived from the immutable identity of
 * the request (tenant slug + administrator email), so a resubmitted form
 * returns the original result instead of creating a second tenant, while a
 * genuinely different request is a genuinely different bootstrap.
 */
export function bootstrapFingerprint(request: BootstrapRequest): string {
  const slug = tenantSlugFrom(request.property.name);
  const email = request.administrator.email.trim().toLowerCase();
  return `nova-bootstrap:${slug}:${email}`;
}