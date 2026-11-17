import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import { generateApiKey, sha256Hex } from "./crypto.server";
import { resolveCredential } from "./credentials.server";

function seededSupabase(overrides: Record<string, unknown> = {}) {
  const generated = generateApiKey();
  const row = {
    id: "cred-1",
    tenant_id: "tenant-a",
    property_id: null,
    service_user_id: "svc-1",
    scopes: ["orders:read", "orders:write"],
    status: "active",
    key_prefix: generated.prefix,
    key_hash: generated.hash,
    expires_at: null,
    ...overrides,
  };
  const sb = createFakeSupabase({ api_credentials: [row] });
  return { sb, token: generated.token, row };
}

describe("credentials.server — resolveCredential (adversarial)", () => {
  it("resolves a valid, active, non-expired credential", async () => {
    const { sb, token } = seededSupabase();
    const resolved = await resolveCredential(sb, token);
    expect(resolved).not.toBeNull();
    expect(resolved?.tenantId).toBe("tenant-a");
    expect(resolved?.scopes).toEqual(["orders:read", "orders:write"]);
  });

  it("rejects a malformed/garbage token (missing authentication surface)", async () => {
    const { sb } = seededSupabase();
    expect(await resolveCredential(sb, "not-a-token-at-all")).toBeNull();
    expect(await resolveCredential(sb, "")).toBeNull();
    expect(await resolveCredential(sb, "Bearer nova_v1_x")).toBeNull();
  });

  it("rejects a well-formed token for an unknown prefix", async () => {
    const { sb } = seededSupabase();
    const other = generateApiKey();
    expect(await resolveCredential(sb, other.token)).toBeNull();
  });

  it("rejects the correct prefix with the WRONG secret — cannot be forged by guessing", async () => {
    const { sb, row } = seededSupabase();
    const forged = `nova_v1_${row.key_prefix}_${"a".repeat(40)}`;
    expect(await resolveCredential(sb, forged)).toBeNull();
  });

  it("rejects a revoked credential even with the exact correct secret", async () => {
    const { sb, token } = seededSupabase({ status: "revoked" });
    expect(await resolveCredential(sb, token)).toBeNull();
  });

  it("rejects an expired credential even with the exact correct secret", async () => {
    const { sb, token } = seededSupabase({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await resolveCredential(sb, token)).toBeNull();
  });

  it("accepts a credential whose expiry is in the future", async () => {
    const { sb, token } = seededSupabase({
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await resolveCredential(sb, token)).not.toBeNull();
  });

  it("a hash collision on a DIFFERENT secret with the same prefix is still rejected (hash is verified, not just presence)", async () => {
    const { sb, row } = seededSupabase();
    // Same prefix, but hash of a totally different secret than what's stored.
    const impostor = `nova_v1_${row.key_prefix}_${sha256Hex("impostor").slice(0, 32)}`;
    expect(await resolveCredential(sb, impostor)).toBeNull();
  });
});
