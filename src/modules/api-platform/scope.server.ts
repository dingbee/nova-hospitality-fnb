/**
 * P08 — external API scope checks. These run BEFORE any domain *.server.ts
 * function is called, using only the resolved credential's own fields
 * (never a client-supplied id) — the property/tenant check every domain
 * function performs internally (via assertCapability/assertTenantRead
 * against the synthetic service-account membership row) is a second,
 * independent layer behind this one, not a replacement for it.
 */
import { ApiError } from "./errors";
import type { ApiScope } from "./contracts";
import type { ResolvedCredential } from "./credentials.server";

export function requireScope(credential: ResolvedCredential, scope: ApiScope): void {
  if (!credential.scopes.includes(scope)) {
    throw new ApiError("forbidden", `This credential is not scoped for "${scope}".`);
  }
}

/** null/undefined propertyId = the resource has no property of its own — always covered. */
export function credentialCoversProperty(
  credential: ResolvedCredential,
  propertyId: string | null | undefined,
): boolean {
  if (propertyId === undefined || propertyId === null) return true;
  if (credential.propertyId === null) return true; // tenant-wide credential
  return credential.propertyId === propertyId;
}

export function assertCredentialCoversProperty(
  credential: ResolvedCredential,
  propertyId: string | null | undefined,
): void {
  if (!credentialCoversProperty(credential, propertyId)) {
    throw new ApiError("forbidden", "This credential is not scoped to that property.");
  }
}
