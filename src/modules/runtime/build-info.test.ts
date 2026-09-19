import { describe, expect, it } from "vitest";
import { resolveBuildId, resolveBuildIdentity } from "./build-info";
import { APP_VERSION } from "./version";

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
    });
    expect(identity).toEqual({
      appVersion: APP_VERSION,
      buildId: "abc123",
      vercelEnv: "production",
    });
  });
});
