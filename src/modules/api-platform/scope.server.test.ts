import { describe, expect, it } from "vitest";
import {
  assertCredentialCoversProperty,
  credentialCoversProperty,
  requireScope,
} from "./scope.server";
import { ApiError } from "./errors";
import type { ResolvedCredential } from "./credentials.server";

function credential(overrides: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    id: "cred-1",
    tenantId: "tenant-a",
    propertyId: null,
    serviceUserId: "svc-1",
    scopes: ["orders:read"],
    ...overrides,
  };
}

describe("scope.server — requireScope", () => {
  it("passes when the credential declares the scope", () => {
    expect(() =>
      requireScope(credential({ scopes: ["orders:write"] }), "orders:write"),
    ).not.toThrow();
  });

  it("throws a 403 ApiError when the credential lacks the scope — privilege escalation guard", () => {
    const cred = credential({ scopes: ["orders:read"] });
    expect(() => requireScope(cred, "orders:write")).toThrow(ApiError);
    try {
      requireScope(cred, "orders:write");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
    }
  });

  it("a read-only credential can never satisfy a write scope, however it's phrased", () => {
    const cred = credential({ scopes: ["orders:read", "menus:read", "locations:read"] });
    expect(() => requireScope(cred, "orders:write")).toThrow(ApiError);
  });
});

describe("scope.server — property coverage (cross-property access guard)", () => {
  it("a tenant-wide credential (propertyId null) covers every property", () => {
    const cred = credential({ propertyId: null });
    expect(credentialCoversProperty(cred, "property-x")).toBe(true);
    expect(credentialCoversProperty(cred, "property-y")).toBe(true);
  });

  it("a property-scoped credential covers only its own property", () => {
    const cred = credential({ propertyId: "property-a" });
    expect(credentialCoversProperty(cred, "property-a")).toBe(true);
    expect(credentialCoversProperty(cred, "property-b")).toBe(false);
  });

  it("a resource with no property of its own is always covered (nothing to scope-check)", () => {
    const cred = credential({ propertyId: "property-a" });
    expect(credentialCoversProperty(cred, null)).toBe(true);
    expect(credentialCoversProperty(cred, undefined)).toBe(true);
  });

  it("assertCredentialCoversProperty throws a 403 ApiError on a cross-property attempt", () => {
    const cred = credential({ propertyId: "property-a" });
    expect(() => assertCredentialCoversProperty(cred, "property-b")).toThrow(ApiError);
    try {
      assertCredentialCoversProperty(cred, "property-b");
    } catch (err) {
      expect((err as ApiError).status).toBe(403);
    }
  });
});
