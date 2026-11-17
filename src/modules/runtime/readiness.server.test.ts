/**
 * ME-16 remediation (ME16-09) — the hosted `/api/v1/ready` endpoint's
 * underlying check. Proves it distinguishes ready/not-ready with correct
 * semantics and never leaks a secret, a connection string, or SQL — only
 * static inspection of `/api/v1/health` was possible before this pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        limit: () => ({
          abortSignal: mocks.select,
        }),
      }),
    }),
  },
}));

const ORIGINAL_ENV = { ...process.env };

describe("checkReadiness", () => {
  beforeEach(() => {
    mocks.select.mockReset();
    process.env = { ...ORIGINAL_ENV, VERCEL_GIT_COMMIT_SHA: "test-sha-123" };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("reports ready:true with build identity when the dependency check succeeds", async () => {
    mocks.select.mockResolvedValue({ error: null });
    const { checkReadiness } = await import("./readiness.server");
    const result = await checkReadiness("lexibite-api");

    expect(result.ready).toBe(true);
    expect(result.buildId).toBe("test-sha-123");
    expect(result.reason).toBeUndefined();
  });

  it("reports ready:false with a safe reason (no error detail) when the dependency check fails", async () => {
    mocks.select.mockResolvedValue({
      error: { message: "connection to server at 10.0.0.5 failed" },
    });
    const { checkReadiness } = await import("./readiness.server");
    const result = await checkReadiness("lexibite-api");

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("database_unreachable");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });

  it("reports ready:false (not a crash) when the Supabase client itself cannot be constructed", async () => {
    vi.doMock("@/integrations/supabase/client.server", () => ({
      get supabaseAdmin(): never {
        throw new Error("Missing Supabase environment variable(s): SUPABASE_SERVICE_ROLE_KEY.");
      },
    }));
    vi.resetModules();
    const { checkReadiness } = await import("./readiness.server");
    const result = await checkReadiness("lexibite-api");

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("database_unreachable");
    expect(JSON.stringify(result)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
