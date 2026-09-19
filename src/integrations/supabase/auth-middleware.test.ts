/**
 * ME-16 remediation (ME16-05) — every denial branch of `requireSupabaseAuth`
 * must now log enough to answer "who was refused, when, why" without ever
 * logging the presented token. Reproduces each denial path directly
 * against `requireSupabaseAuth.options.server`, the same pattern used by
 * server-fn-correlation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequest: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims } }),
}));

const ORIGINAL_ENV = { ...process.env };

describe("requireSupabaseAuth denial logging", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    mocks.getRequest.mockReset();
    mocks.getClaims.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  async function loadMiddleware() {
    vi.resetModules();
    const mod = await import("./auth-middleware");
    return mod.requireSupabaseAuth;
  }

  it("logs (without the token) and denies when no authorization header is present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getRequest.mockReturnValue({ headers: new Headers() });
    const requireSupabaseAuth = await loadMiddleware();
    const next = vi.fn();

    await expect(
      requireSupabaseAuth.options.server!({ next, context: { requestId: "req-a" } } as never),
    ).rejects.toThrow("Unauthorized: No authorization header provided");

    expect(next).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0]!;
    expect(tag).toBe("[auth]");
    const parsed = JSON.parse(payload as string);
    expect(parsed.requestId).toBe("req-a");
    expect(parsed.reason).toBe("missing_authorization_header");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("Bearer");
  });

  it("logs and denies an invalid/expired token without leaking it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getRequest.mockReturnValue({
      headers: new Headers({ authorization: "Bearer some-secret-token-value" }),
    });
    mocks.getClaims.mockResolvedValue({ data: null, error: { message: "invalid JWT" } });
    const requireSupabaseAuth = await loadMiddleware();
    const next = vi.fn();

    await expect(
      requireSupabaseAuth.options.server!({ next, context: { requestId: "req-b" } } as never),
    ).rejects.toThrow("Unauthorized: Invalid token");

    expect(next).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = errorSpy.mock.calls[0]!;
    expect(tag).toBe("[auth]");
    const parsed = JSON.parse(payload as string);
    expect(parsed.requestId).toBe("req-b");
    expect(parsed.reason).toBe("token_verification_failed");
    // The raw token/credential must never appear in what was logged.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("some-secret-token-value");
  });

  it("passes through to next() with userId/claims on a valid token, logging nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getRequest.mockReturnValue({
      headers: new Headers({ authorization: "Bearer valid-token" }),
    });
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    const requireSupabaseAuth = await loadMiddleware();
    const next = vi.fn(async (opts) => ({ context: opts.context }));

    await requireSupabaseAuth.options.server!({ next, context: {} } as never);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ userId: "user-1" }) }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
