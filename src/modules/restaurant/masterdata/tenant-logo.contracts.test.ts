import { describe, expect, it } from "vitest";
import { TENANT_LOGO_MAX_BYTES, validateTenantLogoFile } from "./tenant-logo.contracts";

function fakeFile(type: string, size: number): File {
  return { type, size } as File;
}

describe("validateTenantLogoFile", () => {
  it("accepts jpeg/png/webp within the size limit", () => {
    expect(validateTenantLogoFile(fakeFile("image/jpeg", 1000))).toBeNull();
    expect(validateTenantLogoFile(fakeFile("image/png", 1000))).toBeNull();
    expect(validateTenantLogoFile(fakeFile("image/webp", 1000))).toBeNull();
  });

  it("rejects SVG — the same safety choice the storage bucket and server enforce", () => {
    expect(validateTenantLogoFile(fakeFile("image/svg+xml", 1000))).toMatch(/JPEG, PNG or WebP/);
  });

  it("rejects any other MIME type", () => {
    expect(validateTenantLogoFile(fakeFile("application/pdf", 1000))).toMatch(/JPEG, PNG or WebP/);
    expect(validateTenantLogoFile(fakeFile("image/gif", 1000))).toMatch(/JPEG, PNG or WebP/);
  });

  it("rejects a file over the size limit", () => {
    expect(validateTenantLogoFile(fakeFile("image/png", TENANT_LOGO_MAX_BYTES + 1))).toMatch(
      /too large/,
    );
  });

  it("accepts a file exactly at the size limit", () => {
    expect(validateTenantLogoFile(fakeFile("image/png", TENANT_LOGO_MAX_BYTES))).toBeNull();
  });
});
