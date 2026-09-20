import { describe, expect, it } from "vitest";
import { resolveBuildId, resolveBuildIdentity } from "./build-info";
import { APP_VERSION, REQUIRED_SCHEMA_VERSION } from "./version";

describe("resolveBuildId", () => {
  it("uses VERCEL_GIT_COMMIT_SHA when present (Vercel's own system env var)", () => {
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "abc123" })).toBe("abc123");
  });

  it("never fabricates a SHA — reports 'unknown' when nothing is set", () => {
    expect(resolveBuildId({})).toBe("unknown");
  });

  it("falls back through SOURCE_VERSION then GIT_SHA before giving up", () => {
    expect(resolveBuildId({ SOURCE_VERSION: "src-sha" })).toBe("src-sha");
    expect(resolveBuildId({ GIT_SHA: "git-sha" })).toBe("git-sha");
  });
});

describe("resolveBuildIdentity", () => {
  it("reports the authoritative APP_VERSION constant, not package.json's cosmetic field", () => {
    const identity = resolveBuildIdentity({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_ENV: "production",
      VERCEL_DEPLOYMENT_ID: "dpl_123",
      VERCEL_PROJECT_PRODUCTION_URL: "lexibite.example.com",
      LEXIBITE_BUILD_TIMESTAMP: "2026-09-20T14:00:00Z",
    });
    expect(identity).toEqual({
      appVersion: APP_VERSION,
      buildId: "abc123",
      vercelEnv: "production",
      deploymentId: "dpl_123",
      deploymentUrl: "lexibite.example.com",
      buildTimestamp: "2026-09-20T14:00:00.000Z",
      schemaVersion: REQUIRED_SCHEMA_VERSION,
    });
  });
});
