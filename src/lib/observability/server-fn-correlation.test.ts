/**
 * `withRequestCorrelation` is registered as a global `functionMiddleware`
 * in src/start.ts, which `@tanstack/start-client-core`'s executeMiddleware
 * composes as: for each middleware, call its `.options.server` with a
 * `next` that (a) merges any context it passes forward and (b) re-throws
 * whatever the deeper middleware/handler threw (confirmed by reading
 * node_modules/@tanstack/start-client-core/dist/esm/createServerFn.js's
 * `callNextMiddleware`/`userNext`). These tests reproduce that exact
 * contract with a minimal fake `next`, rather than trusting the framework
 * wiring blindly — the same style this repo's own auth/rbac tests use for
 * `createMiddleware`-based factories.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { withRequestCorrelation } from "./server-fn-correlation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("withRequestCorrelation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("generates a requestId, passes it to next() in context, and returns next()'s result unchanged on success", async () => {
    const next = vi.fn(async (opts?: { context?: Record<string, unknown> }) => ({
      context: opts?.context,
      result: "ok",
    }));

    const result = await withRequestCorrelation.options.server!({
      next,
      serverFnMeta: { id: "fn1", name: "myServerFn", filename: "src/modules/x.functions.ts" },
    } as never);

    expect(next).toHaveBeenCalledTimes(1);
    const passedContext = next.mock.calls[0]![0]?.context as { requestId: string };
    expect(passedContext.requestId).toMatch(UUID_RE);
    expect(result).toEqual({ context: passedContext, result: "ok" });
  });

  it("logs the failure (requestId, function name/file) and rethrows the SAME error unchanged when next() throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalError = new Error("Unauthorized: No authorization header provided");
    const next = vi.fn(async () => {
      throw originalError;
    });

    await expect(
      withRequestCorrelation.options.server!({
        next,
        serverFnMeta: {
          id: "fn2",
          name: "askStaffNovaFn",
          filename: "src/modules/staffnova.functions.ts",
        },
      } as never),
    ).rejects.toBe(originalError);

    // Message/type is untouched — no weakening of existing error semantics.
    expect(originalError.message).toBe("Unauthorized: No authorization header provided");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [tag, payload, loggedError] = errorSpy.mock.calls[0]!;
    expect(tag).toBe("[server-fn]");
    const parsed = JSON.parse(payload as string);
    expect(parsed.requestId).toMatch(UUID_RE);
    expect(parsed.fn).toBe("askStaffNovaFn");
    expect(parsed.file).toBe("src/modules/staffnova.functions.ts");
    expect(loggedError).toBe(originalError);
  });

  it("attaches requestId onto the thrown error so a client-side presenter can quote a reference", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const originalError = new Error("boom");
    const next = vi.fn(async () => {
      throw originalError;
    });

    try {
      await withRequestCorrelation.options.server!({ next, serverFnMeta: undefined } as never);
      throw new Error("expected withRequestCorrelation to rethrow");
    } catch (caught) {
      expect((caught as { requestId?: string }).requestId).toMatch(UUID_RE);
    }
  });
});
