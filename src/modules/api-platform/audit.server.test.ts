/**
 * P08 — external API rate limiting. There was previously no test coverage
 * for either limiter (ME-12 finding): the per-credential sliding window,
 * and the per-IP limiter on unauthenticated requests added during ME-12
 * to close a real gap — a flood of requests with no valid bearer token
 * had no throttling at any layer before this, since the per-credential
 * limiter only ever runs after a credential has already resolved.
 */
import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/modules/commercial/test-helpers/fakeSupabase";
import { assertIpWithinAuthFailureRateLimit, assertWithinRateLimit } from "./audit.server";
import { ApiError } from "./errors";

function logRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "req",
    tenant_id: "tenant-a",
    property_id: null,
    credential_id: null,
    method: "GET",
    endpoint: "/api/v1/orders",
    status_code: 200,
    duration_ms: 1,
    ip: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("assertWithinRateLimit — per-credential sliding window", () => {
  it("allows a credential well under the limit", async () => {
    const rows = Array.from({ length: 5 }, () => logRow({ credential_id: "cred-1" }));
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertWithinRateLimit(sb, "cred-1")).resolves.toBeUndefined();
  });

  it("rejects once a credential hits the per-minute ceiling", async () => {
    const rows = Array.from({ length: 120 }, () => logRow({ credential_id: "cred-1" }));
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertWithinRateLimit(sb, "cred-1")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("does not count a DIFFERENT credential's requests against this one", async () => {
    const rows = Array.from({ length: 200 }, () => logRow({ credential_id: "cred-OTHER" }));
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertWithinRateLimit(sb, "cred-1")).resolves.toBeUndefined();
  });

  it("does not count requests outside the one-minute window", async () => {
    const stale = Array.from({ length: 200 }, () =>
      logRow({
        credential_id: "cred-1",
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    const sb = createFakeSupabase({ api_request_log: stale });
    await expect(assertWithinRateLimit(sb, "cred-1")).resolves.toBeUndefined();
  });
});

describe("assertIpWithinAuthFailureRateLimit — per-IP limiter on failed/no auth", () => {
  it("allows a fresh IP with no prior failures", async () => {
    const sb = createFakeSupabase({ api_request_log: [] });
    await expect(assertIpWithinAuthFailureRateLimit(sb, "203.0.113.1")).resolves.toBeUndefined();
  });

  it("rejects once an IP's unauthenticated request count hits the ceiling", async () => {
    const rows = Array.from({ length: 60 }, () =>
      logRow({ ip: "203.0.113.1", credential_id: null, status_code: 401 }),
    );
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertIpWithinAuthFailureRateLimit(sb, "203.0.113.1")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("never counts requests that DID resolve a valid credential from the same IP — shared/NAT IPs with real traffic are unaffected", async () => {
    const rows = Array.from({ length: 200 }, () =>
      logRow({ ip: "203.0.113.1", credential_id: "cred-1", status_code: 200 }),
    );
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertIpWithinAuthFailureRateLimit(sb, "203.0.113.1")).resolves.toBeUndefined();
  });

  it("does not count a DIFFERENT IP's unauthenticated flood against this one", async () => {
    const rows = Array.from({ length: 200 }, () =>
      logRow({ ip: "198.51.100.9", credential_id: null }),
    );
    const sb = createFakeSupabase({ api_request_log: rows });
    await expect(assertIpWithinAuthFailureRateLimit(sb, "203.0.113.1")).resolves.toBeUndefined();
  });

  it("is a no-op when no IP is available (nothing to key the limit on)", async () => {
    const sb = createFakeSupabase({ api_request_log: [] });
    await expect(assertIpWithinAuthFailureRateLimit(sb, null)).resolves.toBeUndefined();
  });

  it("throws an ApiError instance, not a generic Error", async () => {
    const rows = Array.from({ length: 60 }, () =>
      logRow({ ip: "203.0.113.1", credential_id: null }),
    );
    const sb = createFakeSupabase({ api_request_log: rows });
    try {
      await assertIpWithinAuthFailureRateLimit(sb, "203.0.113.1");
      throw new Error("expected assertIpWithinAuthFailureRateLimit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });
});
